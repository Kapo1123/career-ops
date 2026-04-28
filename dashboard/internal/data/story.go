package data

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var reStoryHeader = regexp.MustCompile(`^###\s+\[([^\]]+)\]\s+(.+)$`)
var reField = regexp.MustCompile(`^\*\*([^*]+)\*\*\s*(.*)$`)

// StoryBankPath returns the path to story-bank.md.
func StoryBankPath(careerOpsPath string) string {
	return filepath.Join(careerOpsPath, "interview-prep", "story-bank.md")
}

// ParseStories reads and parses story-bank.md into Story structs.
func ParseStories(careerOpsPath string) []model.Story {
	path := StoryBankPath(careerOpsPath)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	lines := strings.Split(string(raw), "\n")
	var stories []model.Story
	idx := 0

	i := 0
	for i < len(lines) {
		m := reStoryHeader.FindStringSubmatch(lines[i])
		if m == nil {
			i++
			continue
		}

		story := model.Story{
			Index:     idx,
			Theme:     m[1],
			Title:     m[2],
			StartLine: i,
		}

		// Collect block until next ### or end
		blockStart := i
		i++
		for i < len(lines) {
			if strings.HasPrefix(lines[i], "### ") {
				break
			}
			// Parse STAR+R fields
			fm := reField.FindStringSubmatch(strings.TrimSpace(lines[i]))
			if fm != nil {
				key := strings.TrimSuffix(strings.TrimSpace(fm[1]), ":")
				val := strings.TrimSpace(fm[2])
				// Gather continuation lines (non-field, non-empty following lines)
				for i+1 < len(lines) {
					next := strings.TrimSpace(lines[i+1])
					if next == "" || strings.HasPrefix(next, "**") || strings.HasPrefix(next, "###") || strings.HasPrefix(next, "---") {
						break
					}
					val += " " + next
					i++
				}
				switch key {
				case "S (Situation)":
					story.Situation = val
				case "T (Task)":
					story.Task = val
				case "A (Action)":
					story.Action = val
				case "R (Result)":
					story.Result = val
				case "Reflection":
					story.Reflection = val
				case "Best for questions about":
					story.BestFor = val
				}
			}
			i++
		}

		// Capture raw block (trim trailing blank lines)
		blockLines := lines[blockStart:i]
		for len(blockLines) > 0 && strings.TrimSpace(blockLines[len(blockLines)-1]) == "" {
			blockLines = blockLines[:len(blockLines)-1]
		}
		story.RawBlock = strings.Join(blockLines, "\n")

		stories = append(stories, story)
		idx++
	}

	return stories
}

// SaveStory replaces a story's raw block in story-bank.md with newBlock.
func SaveStory(careerOpsPath string, story model.Story, newBlock string) error {
	path := StoryBankPath(careerOpsPath)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	updated := strings.Replace(string(raw), story.RawBlock, newBlock, 1)
	return os.WriteFile(path, []byte(updated), 0644)
}
