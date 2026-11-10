package main

import (
	"math"
	"strings"
)

// Reserved control-character keys keep the legacy name->integer scores.json
// format readable while atomically persisting ratings in that same file.
const ratingPrefix = "\x1frating:"

func safetyGrade(score int64) string {
	for i, threshold := range []int64{90, 75, 60, 45, 30} {
		if score >= threshold {
			return []string{"S", "A", "B", "C", "D"}[i]
		}
	}
	return "E"
}
func (h *Hub) ratingOf(name string) (int64, int64) {
	skill, ok := h.points[ratingPrefix+"skill:"+name]
	if !ok {
		skill = 1000
	}
	safety, ok := h.points[ratingPrefix+"safety:"+name]
	if !ok {
		safety = 70
	}
	return skill, safety
}
func (h *Hub) updateRaceRatings(players []*Client, results []Result) {
	human := make([]*Client, 0, len(players))
	rank := map[int]int{}
	for _, r := range results {
		rank[r.ID] = r.Rank
	}
	for _, p := range players {
		if !p.ai && !isBotName(p.name) {
			human = append(human, p)
		}
	}
	deltas := make(map[int]int64)
	for _, p := range human {
		skill, _ := h.ratingOf(p.name)
		delta := 0.0
		for _, q := range human {
			if p == q {
				continue
			}
			other, _ := h.ratingOf(q.name)
			actual := 0.0
			if rank[p.id] < rank[q.id] {
				actual = 1
			}
			expected := 1 / (1 + math.Pow(10, float64(other-skill)/400))
			delta += 24 * (actual - expected)
		}
		if len(human) > 1 {
			deltas[p.id] = int64(math.Round(delta / float64(len(human)-1)))
		}
	}
	for _, p := range human {
		skill, safety := h.ratingOf(p.name)
		skill += deltas[p.id]
		if skill < 0 {
			skill = 0
		}
		if skill > 5000 {
			skill = 5000
		}
		safety += 3 - int64(p.violations)*4 - int64(p.unsafeIncidents)*8
		if !p.finished {
			safety--
		}
		if safety < 0 {
			safety = 0
		}
		if safety > 100 {
			safety = 100
		}
		h.points[ratingPrefix+"skill:"+p.name] = skill
		h.points[ratingPrefix+"safety:"+p.name] = safety
		p.skillRating = skill
		p.safetyRating = safety
	}
}
func isRatingKey(name string) bool { return strings.HasPrefix(name, ratingPrefix) }
