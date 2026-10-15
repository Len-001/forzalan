package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestFinishedBotCruiseStateDoesNotRewriteResult(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "CRUI", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{}), started: true, startAt: time.Now().Add(-10 * time.Second)}
	h.rooms[r.id] = r
	host := newProtocolTestClient("Host")
	attachProtocolTestClient(t, h, r, host)
	r.started = true
	bot := &Client{room: r, ai: true, id: 2, name: "AI", ownerID: host.id, finished: true, locked: true, lap: 3, cp: 7, bestLap: 42, total: 126, rank: 1}
	r.players = append(r.players, bot)
	h.handleFrame(host, []byte(`{"t":"state","id":2,"seq":8,"d":{"x":300,"y":2,"z":400,"l":1,"c":1,"s":60,"q":[0,0,0,1],"f":1}}`))
	var d struct {
		X float64 `json:"x"`
	}
	if err := json.Unmarshal(bot.state, &d); err != nil || d.X != 300 {
		t.Fatalf("finished cruise state was not relayed: %s (%v)", bot.state, err)
	}
	if bot.lap != 3 || bot.cp != 7 || bot.total != 126 || bot.bestLap != 42 || bot.rank != 1 {
		t.Fatal("cruise changed locked result")
	}
	h.handleFrame(host, []byte(`{"t":"state","id":2,"seq":7,"d":{"x":9}}`))
	if err := json.Unmarshal(bot.state, &d); err != nil || d.X != 300 {
		t.Fatal("out-of-order finished state replaced newer cruise pose")
	}
}

func TestRestartRequiresHostAndFinishedState(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "RESTART", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	host := newProtocolTestClient("Host")
	other := newProtocolTestClient("Other")
	attachProtocolTestClient(t, h, r, host)
	attachProtocolTestClient(t, h, r, other)

	r.mu.Lock()
	r.started = true
	r.racing = true
	r.finished = false
	r.mu.Unlock()

	h.handleFrame(other, []byte(`{"t":"restart"}`))
	r.mu.Lock()
	if !r.started || !r.racing {
		r.mu.Unlock()
		t.Fatal("non-host restart cleared an active race")
	}
	r.mu.Unlock()

	h.handleFrame(host, []byte(`{"t":"restart"}`))
	r.mu.Lock()
	if !r.started || !r.racing {
		r.mu.Unlock()
		t.Fatal("host restart cleared a race before settlement")
	}
	r.finished = true
	r.mu.Unlock()

	h.handleFrame(other, []byte(`{"t":"restart"}`))
	r.mu.Lock()
	if !r.started || !r.racing {
		r.mu.Unlock()
		t.Fatal("non-host restart cleared a settled race")
	}
	r.started = false
	r.mu.Unlock()

	h.handleFrame(host, []byte(`{"t":"restart"}`))
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.racing || r.finished {
		t.Fatalf("host restart did not return to lobby: started=%v racing=%v finished=%v", r.started, r.racing, r.finished)
	}
}

func TestCancelledCountdownCannotEmitStaleStartSequence(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "STALE", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	host := newProtocolTestClient("Host")
	attachProtocolTestClient(t, h, r, host)
	r.mu.Lock()
	host.ready = true
	r.beginCountdownLocked()
	r.mu.Unlock()

	// Re-enter the lobby and immediately prepare again while the old goroutine
	// is asleep. Without a generation guard, both countdowns reach START.
	time.Sleep(1100 * time.Millisecond)
	r.mu.Lock()
	r.backToLobbyLocked()
	host.ready = true
	r.beginCountdownLocked()
	r.mu.Unlock()

	time.Sleep(4500 * time.Millisecond)
	starts := 0
	for {
		select {
		case raw := <-host.send:
			var msg map[string]any
			if json.Unmarshal(raw, &msg) == nil && msg["t"] == "start" {
				starts++
			}
		default:
			if starts != 0 {
				t.Fatalf("cancelled countdown emitted %d stale start messages before the replacement countdown", starts)
			}
			r.mu.Lock()
			staleStarted := r.started
			r.backToLobbyLocked()
			r.mu.Unlock()
			if staleStarted {
				t.Fatal("cancelled countdown changed the room back to started")
			}
			return
		}
	}
}
