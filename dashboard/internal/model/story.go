package model

// Story represents a single STAR+R behavioral story from the story bank.
type Story struct {
	Index       int
	Theme       string // e.g. "Scale / Impact"
	Title       string // e.g. "500% Pipeline Scale — Lucid Software"
	Situation   string
	Task        string
	Action      string
	Result      string
	Reflection  string
	BestFor     string
	RawBlock    string // full original markdown block for editing/AI
	StartLine   int    // line number in file (0-indexed)
}
