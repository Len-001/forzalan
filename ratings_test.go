package main

import (
	"os"
	"strings"
	"testing"
)

func TestCompetitiveRatingsPersistence(t *testing.T) {
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(old)
	h := &Hub{points: map[string]int64{"Alice": 10, "Bob": 5}}
	a := &Client{id: 1, name: "Alice", finished: true}
	b := &Client{id: 2, name: "Bob", finished: true, violations: 2, unsafeIncidents: 1}
	h.updateRaceRatings([]*Client{a, b}, []Result{{ID: 1, Rank: 1}, {ID: 2, Rank: 2}})
	if a.skillRating <= 1000 || b.skillRating >= 1000 || a.safetyRating <= b.safetyRating {
		t.Fatal("ratings did not reflect result/safety", a.skillRating, b.skillRating)
	}
	h.savePoints()
	loaded := &Hub{points: map[string]int64{}}
	loaded.loadPoints()
	skill, safety := loaded.ratingOf("Alice")
	if skill != a.skillRating || safety != a.safetyRating {
		t.Fatal("ratings were not restored from scores.json")
	}
	if strings.Contains(h.seasonBoardLocked(), "rating:") {
		t.Fatal("rating metadata leaked into the player board")
	}
	if safetyGrade(95) != "S" || safetyGrade(0) != "E" {
		t.Fatal("invalid safety grade")
	}
}
func TestCompetitiveGridUsesRating(t *testing.T) {
	a := &Client{id: 1, points: 1, skillRating: 1300}
	b := &Client{id: 2, points: 100, skillRating: 1100}
	r := &Room{gameMode: "fm8", players: []*Client{a, b}}
	r.assignGridLocked()
	if a.gridSlot != 1 {
		t.Fatal("higher skill must start first in Spec Series")
	}
}
