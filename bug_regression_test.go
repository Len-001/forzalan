package main

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSnapshotsKeepStateAgeAndRejectDuplicates(t *testing.T) {
	h, r, c := regressionRoom(t)
	r.started = true
	h.handleFrame(c, []byte(`{"t":"state","seq":1,"d":{"x":10,"v":[20,0,0]}}`))
	time.Sleep(40 * time.Millisecond)
	h.handleFrame(c, []byte(`{"t":"state","seq":1,"d":{"x":999}}`))
	var snap struct {
		Players []struct {
			Age int64 `json:"age"`
			D   struct {
				X float64 `json:"x"`
			} `json:"d"`
		} `json:"p"`
	}
	if err := json.Unmarshal(r.snapshotLocked(), &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Players) != 1 || snap.Players[0].Age < 30 || snap.Players[0].D.X != 10 {
		t.Fatalf("rebroadcast must preserve age and duplicate must not replace pose: %+v", snap)
	}
}

func regressionRoom(t *testing.T) (*Hub, *Room, *Client) {
	t.Helper()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Error(err)
		}
	})
	h := newHub()
	r := &Room{hub: h, id: "REGT", laps: 3, close: make(chan struct{})}
	h.rooms[r.id] = r
	c := newProtocolTestClient("RegressionDriver")
	attachProtocolTestClient(t, h, r, c)
	h.clients[c] = struct{}{}
	return h, r, c
}

func TestLapAndStateResetPassagesInEitherOrder(t *testing.T) {
	for _, lapFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "lap-first", false: "state-first"}[lapFirst], func(t *testing.T) {
			h, r, c := regressionRoom(t)
			r.started = true
			h.handleFrame(c, []byte(`{"t":"state","seq":1,"d":{"l":0,"c":23,"p":0.99,"n":5}}`))
			lap := []byte(`{"t":"lap","n":1,"time":90}`)
			state := []byte(`{"t":"state","seq":2,"d":{"l":1,"c":0,"p":0.01,"n":200}}`)
			if lapFirst {
				h.handleFrame(c, lap)
				h.handleFrame(c, state)
			} else {
				h.handleFrame(c, state)
				h.handleFrame(c, lap)
			}
			if c.lap != 1 || c.cp != 0 || c.sliceAt != 10 || c.sliceTime[1013] != 0 || c.passTime[23] != 0 {
				t.Fatalf("old lap survived rollover: lap=%d cp=%d sliceAt=%d", c.lap, c.cp, c.sliceAt)
			}
		})
	}
}

func TestControlOverflowClosesConnection(t *testing.T) {
	c := newProtocolTestClient("SlowDriver")
	for i := 0; i < cap(c.send); i++ {
		c.enqueue([]byte(`{"t":"sping","c":1}`))
	}
	c.enqueue([]byte(`{"t":"start","at":123}`))
	if !c.closed {
		t.Fatal("overflow silently discarded a control message")
	}
	select {
	case <-c.done:
	default:
		t.Fatal("writer/read loop was not notified")
	}
	fast := newProtocolTestClient("FastDriver")
	fast.snaps = make(chan []byte, 1)
	fast.enqueue([]byte(`{"t":"snap","p":[]}`))
	fast.enqueue([]byte(`{"t":"snap","p":[]}`))
	fast.enqueue([]byte(`{"t":"start","at":123}`))
	if fast.closed || len(fast.send) != 1 {
		t.Fatal("snapshot overflow affected control messages")
	}
}

func TestDuplicateRoomRequestsKeepMembershipAndProfile(t *testing.T) {
	h, r, c := regressionRoom(t)
	for _, raw := range []string{`{"t":"join","room":"REGT","name":"Changed"}`, `{"t":"create","name":"Changed","laps":1}`} {
		h.handleFrame(c, []byte(raw))
		if len(h.rooms) != 1 || len(r.players) != 1 || c.id != 1 || c.name != "RegressionDriver" || c.room != r {
			t.Fatal("duplicate request changed profile or duplicated membership")
		}
	}
	if h.attachLocked(r, c) {
		t.Fatal("direct attach accepted an existing member")
	}
}

func TestFinishRequiresGreenAndCompletedLaps(t *testing.T) {
	h, r, c := regressionRoom(t)
	other := newProtocolTestClient("Other")
	attachProtocolTestClient(t, h, r, other)
	r.started = true
	r.startAt = time.Now().Add(3 * time.Second)
	c.lap = r.laps
	h.handleFrame(c, []byte(`{"t":"finish"}`))
	if c.finished {
		t.Fatal("accepted a pre-green finish")
	}
	r.racing = true
	h.handleFrame(c, []byte(`{"t":"finish"}`))
	if c.finished {
		t.Fatal("accepted a future start time")
	}
	r.startAt = time.Now().Add(-time.Second)
	c.lap = 0
	h.handleFrame(c, []byte(`{"t":"finish"}`))
	if c.finished {
		t.Fatal("accepted a zero-lap finish")
	}
	h.handleFrame(c, []byte(`{"t":"lap","n":3,"time":90,"dirty":true}`))
	h.handleFrame(c, []byte(`{"t":"finish"}`))
	if !c.finished || c.total < 0 || c.bestLap != 0 || r.dnfDeadline.IsZero() {
		t.Fatal("valid dirty final lap did not finish or polluted clean lap record")
	}
}

func TestPresenceCannotHoldHubWhileWaitingForSettlement(t *testing.T) {
	h, r, _ := regressionRoom(t)
	r.mu.Lock()
	presenceDone := make(chan struct{})
	go func() { h.presenceSnapshot(); close(presenceDone) }()
	deadline := time.Now().Add(time.Second)
	for {
		buf := make([]byte, 32768)
		if strings.Contains(string(buf[:runtime.Stack(buf, true)]), "(*Hub).presenceSnapshot") {
			break
		}
		if time.Now().After(deadline) {
			r.mu.Unlock()
			t.Fatal("presence did not reach the locked room")
		}
		time.Sleep(time.Millisecond)
	}
	settled := make(chan struct{})
	go func() { r.endRaceLocked("test"); r.mu.Unlock(); close(settled) }()
	select {
	case <-settled:
	case <-time.After(time.Second):
		t.Fatal("room/hub locks deadlocked")
	}
	select {
	case <-presenceDone:
	case <-time.After(time.Second):
		t.Fatal("presence remained blocked")
	}
}

func TestBotHandoffResetsSequence(t *testing.T) {
	h, r, host := regressionRoom(t)
	next := newProtocolTestClient("Next")
	attachProtocolTestClient(t, h, r, next)
	bot := r.addAIBotLocked(host)
	bot.lastSeq = 9999
	r.started = true
	h.leave(host, "disconnect")
	h.handleFrame(next, []byte(`{"t":"state","id":3,"seq":1,"d":{"x":8,"q":[0,0,0,1]}}`))
	if bot.ownerID != next.id || bot.lastSeq != 1 || len(bot.state) == 0 {
		t.Fatal("new host's bot state was rejected")
	}
}

func TestPenaltyReasonsCountViolations(t *testing.T) {
	h, r, c := regressionRoom(t)
	r.started = true
	for _, reason := range []string{"frr_gain", "shortcut", "rescue", "cut"} {
		c.lastPen = time.Time{}
		h.handleFrame(c, []byte(`{"t":"pen","sec":1,"reason":"`+reason+`"}`))
	}
	if c.violations != 4 || c.penalty != 4 {
		t.Fatalf("penalty reasons lost: vio=%d pen=%v", c.violations, c.penalty)
	}
}
