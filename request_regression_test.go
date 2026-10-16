package main

import (
	"encoding/json"
	"testing"
)

func TestRoutePositionOverridesCheckpointAndGrassDistance(t *testing.T) {
	a, b := newTestClient(1, "front", 0), newTestClient(2, "back", 0)
	r := newTestRoom(a, b)
	a.cp, b.cp = 2, 5
	a.distNext = 900
	a.score, b.score = 200, 500
	a.recordRoute(1.40, 1000)
	b.recordRoute(1.39, 1100)
	var msg struct {
		Data []struct {
			ID int `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(r.leaderboardLocked(), &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Data[0].ID != 1 {
		t.Fatalf("grass/checkpoint rank inverted: %s", r.leaderboardLocked())
	}
	if r.resultsLocked()[0].ID != 1 {
		t.Fatal("DNF must follow route position")
	}
}

func TestRouteGapUsesSharedPassageAcrossLine(t *testing.T) {
	a, b := newTestClient(1, "a", 0), newTestClient(2, "b", 0)
	r := newTestRoom(a, b)
	a.recordRoute(.998, 1000)
	a.recordRoute(1.002, 1200)
	b.recordRoute(.998, 1500)
	b.recordRoute(1.001, 1650)
	a.lap, b.lap = 1, 0
	a.cp, b.cp = -1, 23
	gap, ok := r.solveDeltaMs(a, b)
	if !ok || gap < 400 || gap > 600 {
		t.Fatalf("line/grass gap should be ~0.5s, got %f %v", gap, ok)
	}
	reverse, ok := r.solveDeltaMs(b, a)
	if !ok || reverse != -gap {
		t.Fatal("gap must be antisymmetric")
	}
	a.recordRoute(1.5, 1700)
	if _, exists := a.routeTimes[1331]; exists {
		t.Fatal("teleport must not invent passage times")
	}
}

func TestRequestedPenaltyPolicyAtServer(t *testing.T) {
	for _, mode := range []string{"fm8", "horizon", "bumper"} {
		for _, reason := range []string{"wall", "ram", "cut", "shortcut", "rescue", "frr_gain"} {
			a := newTestClient(1, "a", 0)
			r := newTestRoom(a)
			r.gameMode = mode
			r.started = true
			a.room = r
			h := &Hub{}
			raw, _ := json.Marshal(map[string]any{"t": "pen", "sec": 2, "reason": reason})
			h.handleFrame(a, raw)
			want := 2.0
			if mode == "bumper" || reason == "wall" {
				want = 0
			}
			if a.penalty != want {
				t.Fatalf("%s %s: penalty %f want %f", mode, reason, a.penalty, want)
			}
		}
	}
}
