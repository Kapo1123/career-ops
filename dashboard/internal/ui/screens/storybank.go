package screens

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// ── Messages ────────────────────────────────────────────────────────

type StoryBankClosedMsg struct{}
type StoryAIResultMsg struct {
	Result string
	Err    error
}

// ── Sub-states ───────────────────────────────────────────────────────

type storyView int

const (
	storyList   storyView = iota // browsing the story list
	storyDetail                  // viewing a single story
	storyAIEdit                  // AI prompt input + result preview
)

// ── Model ────────────────────────────────────────────────────────────

type StoryBankModel struct {
	stories       []model.Story
	cursor        int
	scrollOffset  int
	detailScroll  int
	view          storyView
	width, height int
	theme         theme.Theme
	careerOpsPath string

	// AI edit state
	aiPrompt    string // current text input
	aiLoading   bool
	aiResult    string // AI-suggested replacement
	aiResultScroll int
	aiError     string
}

func NewStoryBankModel(t theme.Theme, careerOpsPath string, width, height int) StoryBankModel {
	stories := data.ParseStories(careerOpsPath)
	return StoryBankModel{
		stories:       stories,
		theme:         t,
		careerOpsPath: careerOpsPath,
		width:         width,
		height:        height,
	}
}

func (m *StoryBankModel) Reload() {
	m.stories = data.ParseStories(m.careerOpsPath)
	if m.cursor >= len(m.stories) && len(m.stories) > 0 {
		m.cursor = len(m.stories) - 1
	}
}

func (m *StoryBankModel) Resize(w, h int) {
	m.width = w
	m.height = h
}

func (m StoryBankModel) Init() tea.Cmd { return nil }

func (m StoryBankModel) Update(msg tea.Msg) (StoryBankModel, tea.Cmd) {
	switch msg := msg.(type) {

	case StoryAIResultMsg:
		m.aiLoading = false
		if msg.Err != nil {
			m.aiError = "AI error: " + msg.Err.Error()
		} else {
			m.aiResult = msg.Result
			m.aiError = ""
		}
		return m, nil

	case tea.KeyMsg:
		switch m.view {
		case storyList:
			return m.updateList(msg)
		case storyDetail:
			return m.updateDetail(msg)
		case storyAIEdit:
			return m.updateAIEdit(msg)
		}
	}
	return m, nil
}

// ── List navigation ──────────────────────────────────────────────────

func (m StoryBankModel) updateList(msg tea.KeyMsg) (StoryBankModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return StoryBankClosedMsg{} }
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
			if m.cursor < m.scrollOffset {
				m.scrollOffset = m.cursor
			}
		}
	case "down", "j":
		if m.cursor < len(m.stories)-1 {
			m.cursor++
			visibleRows := m.listBodyHeight()
			if m.cursor >= m.scrollOffset+visibleRows {
				m.scrollOffset = m.cursor - visibleRows + 1
			}
		}
	case "enter", " ":
		if len(m.stories) > 0 {
			m.view = storyDetail
			m.detailScroll = 0
		}
	case "e":
		if len(m.stories) > 0 {
			return m.openEditor()
		}
	case "r":
		m.Reload()
	}
	return m, nil
}

// ── Detail navigation ────────────────────────────────────────────────

func (m StoryBankModel) updateDetail(msg tea.KeyMsg) (StoryBankModel, tea.Cmd) {
	lines := m.detailLines()
	maxScroll := len(lines) - m.detailBodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}

	switch msg.String() {
	case "q", "esc":
		m.view = storyList
	case "up", "k":
		if m.detailScroll > 0 {
			m.detailScroll--
		}
	case "down", "j":
		if m.detailScroll < maxScroll {
			m.detailScroll++
		}
	case "pgdown", "ctrl+d":
		m.detailScroll += m.detailBodyHeight() / 2
		if m.detailScroll > maxScroll {
			m.detailScroll = maxScroll
		}
	case "pgup", "ctrl+u":
		m.detailScroll -= m.detailBodyHeight() / 2
		if m.detailScroll < 0 {
			m.detailScroll = 0
		}
	case "a":
		// Open AI edit mode
		m.view = storyAIEdit
		m.aiPrompt = ""
		m.aiResult = ""
		m.aiError = ""
		m.aiLoading = false
		m.aiResultScroll = 0
	case "e":
		return m.openEditor()
	}
	return m, nil
}

// ── AI edit ──────────────────────────────────────────────────────────

func (m StoryBankModel) updateAIEdit(msg tea.KeyMsg) (StoryBankModel, tea.Cmd) {
	// If result is showing, handle accept/reject/scroll
	if m.aiResult != "" && !m.aiLoading {
		resultLines := strings.Split(m.aiResult, "\n")
		maxScroll := len(resultLines) - m.aiResultHeight()
		if maxScroll < 0 {
			maxScroll = 0
		}
		switch msg.String() {
		case "esc":
			if m.aiResult != "" {
				m.aiResult = ""
				m.aiPrompt = ""
			} else {
				m.view = storyDetail
			}
		case "ctrl+a":
			// Accept: write back to file
			if m.cursor < len(m.stories) {
				story := m.stories[m.cursor]
				if err := data.SaveStory(m.careerOpsPath, story, m.aiResult); err != nil {
					m.aiError = "Save failed: " + err.Error()
				} else {
					m.Reload()
					m.view = storyDetail
					m.aiResult = ""
					m.aiPrompt = ""
				}
			}
		case "up", "k":
			if m.aiResultScroll > 0 {
				m.aiResultScroll--
			}
		case "down", "j":
			if m.aiResultScroll < maxScroll {
				m.aiResultScroll++
			}
		case "ctrl+r":
			// Re-run with same prompt
			if m.aiPrompt != "" && m.cursor < len(m.stories) {
				m.aiLoading = true
				m.aiResult = ""
				m.aiError = ""
				story := m.stories[m.cursor]
				prompt := m.aiPrompt
				return m, callClaude(story, prompt)
			}
		}
		return m, nil
	}

	// If loading, only allow escape
	if m.aiLoading {
		if msg.String() == "esc" {
			m.aiLoading = false
			m.view = storyDetail
		}
		return m, nil
	}

	// Prompt input mode
	switch msg.String() {
	case "esc":
		m.view = storyDetail
		m.aiPrompt = ""
	case "enter":
		if strings.TrimSpace(m.aiPrompt) != "" && m.cursor < len(m.stories) {
			m.aiLoading = true
			m.aiError = ""
			story := m.stories[m.cursor]
			prompt := m.aiPrompt
			return m, callClaude(story, prompt)
		}
	case "backspace", "ctrl+h":
		if len(m.aiPrompt) > 0 {
			runes := []rune(m.aiPrompt)
			m.aiPrompt = string(runes[:len(runes)-1])
		}
	case "ctrl+u":
		m.aiPrompt = ""
	default:
		// Only append printable single characters
		if len(msg.String()) == 1 {
			m.aiPrompt += msg.String()
		}
	}
	return m, nil
}

// ── $EDITOR integration ──────────────────────────────────────────────

func (m StoryBankModel) openEditor() (StoryBankModel, tea.Cmd) {
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = "nano"
	}
	path := data.StoryBankPath(m.careerOpsPath)
	cmd := exec.Command(editor, path)
	return m, tea.ExecProcess(cmd, func(err error) tea.Msg {
		return StoryEditorDoneMsg{Err: err}
	})
}

type StoryEditorDoneMsg struct{ Err error }

// ── Claude API call ───────────────────────────────────────────────────

func callClaude(story model.Story, instruction string) tea.Cmd {
	return func() tea.Msg {
		apiKey := os.Getenv("ANTHROPIC_API_KEY")
		if apiKey == "" {
			return StoryAIResultMsg{Err: fmt.Errorf("ANTHROPIC_API_KEY not set")}
		}

		systemPrompt := `You are a behavioral interview coach helping a new grad SWE refine their STAR+R stories.
The candidate is Kapo Kwok: BYU CS Dec 2025 grad, on OPT/H1B, targeting new grad SWE roles.
Key experience: Gmango (Founding Engineer, AI health startup), Lucid Software (SWE intern), BYU Library.
Key metrics: 500% pipeline scale, 4x latency reduction, 85% voice cost reduction, led 7-engineer team.

Return ONLY the revised story block in the exact same markdown format as the input. No preamble, no explanation, no markdown fences. Just the story.`

		userMsg := fmt.Sprintf("Here is the story to refine:\n\n%s\n\nInstruction: %s", story.RawBlock, instruction)

		reqBody, _ := json.Marshal(map[string]any{
			"model":      "claude-haiku-4-5-20251001",
			"max_tokens": 1024,
			"system":     systemPrompt,
			"messages": []map[string]string{
				{"role": "user", "content": userMsg},
			},
		})

		req, err := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(reqBody))
		if err != nil {
			return StoryAIResultMsg{Err: err}
		}
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("content-type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return StoryAIResultMsg{Err: err}
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)

		var parsed struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return StoryAIResultMsg{Err: fmt.Errorf("parse error: %s", string(body)[:min(200, len(body))])}
		}
		if parsed.Error.Message != "" {
			return StoryAIResultMsg{Err: fmt.Errorf("API: %s", parsed.Error.Message)}
		}
		if len(parsed.Content) == 0 {
			return StoryAIResultMsg{Err: fmt.Errorf("empty response")}
		}
		return StoryAIResultMsg{Result: strings.TrimSpace(parsed.Content[0].Text)}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── View ─────────────────────────────────────────────────────────────

func (m StoryBankModel) View() string {
	switch m.view {
	case storyDetail:
		return m.viewDetail()
	case storyAIEdit:
		return m.viewAIEdit()
	default:
		return m.viewList()
	}
}

// ── List view ────────────────────────────────────────────────────────

func (m StoryBankModel) listBodyHeight() int {
	h := m.height - 4
	if h < 3 {
		h = 3
	}
	return h
}

func (m StoryBankModel) viewList() string {
	header := m.renderListHeader()
	body := m.renderListBody()
	footer := m.renderListFooter()
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m StoryBankModel) renderListHeader() string {
	style := lipgloss.NewStyle().Bold(true).
		Foreground(m.theme.Text).Background(m.theme.Surface).
		Width(m.width).Padding(0, 2)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render("STORY BANK")
	count := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("%d stories", len(m.stories)))
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(count) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + count)
}

func (m StoryBankModel) renderListBody() string {
	bh := m.listBodyHeight()
	pad := lipgloss.NewStyle().Padding(0, 2)

	if len(m.stories) == 0 {
		empty := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true).
			Render("No stories found in interview-prep/story-bank.md")
		return pad.Render(empty)
	}

	end := m.scrollOffset + bh
	if end > len(m.stories) {
		end = len(m.stories)
	}

	var rows []string
	for i := m.scrollOffset; i < end; i++ {
		s := m.stories[i]
		selected := i == m.cursor

		themeTag := lipgloss.NewStyle().
			Foreground(m.theme.Sky).
			Render("[" + s.Theme + "]")

		title := lipgloss.NewStyle().
			Foreground(m.theme.Text).
			Bold(selected).
			Render(s.Title)

		best := ""
		if s.BestFor != "" {
			preview := s.BestFor
			maxLen := m.width - lipgloss.Width(themeTag) - lipgloss.Width(title) - 12
			if maxLen > 10 && len(preview) > maxLen {
				preview = preview[:maxLen] + "…"
			}
			best = lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("  · " + preview)
		}

		line := "  " + themeTag + "  " + title + best
		if selected {
			line = lipgloss.NewStyle().
				Background(m.theme.Surface).
				Width(m.width - 4).
				Render(line)
			line = lipgloss.NewStyle().Foreground(m.theme.Mauve).Render("▶ ") + line
		} else {
			line = "  " + line
		}

		rows = append(rows, line)
	}

	for len(rows) < bh {
		rows = append(rows, "")
	}

	return pad.Render(strings.Join(rows, "\n"))
}

func (m StoryBankModel) renderListFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).Background(m.theme.Surface).
		Width(m.width).Padding(0, 1)
	k := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	d := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	return style.Render(
		k.Render("↑↓") + d.Render(" nav  ") +
			k.Render("Enter") + d.Render(" view  ") +
			k.Render("e") + d.Render(" edit in $EDITOR  ") +
			k.Render("r") + d.Render(" reload  ") +
			k.Render("Esc") + d.Render(" back"))
}

// ── Detail view ──────────────────────────────────────────────────────

func (m StoryBankModel) detailBodyHeight() int {
	h := m.height - 4
	if h < 3 {
		h = 3
	}
	return h
}

func (m StoryBankModel) detailLines() []string {
	if m.cursor >= len(m.stories) {
		return nil
	}
	s := m.stories[m.cursor]
	return strings.Split(s.RawBlock, "\n")
}

func (m StoryBankModel) viewDetail() string {
	header := m.renderDetailHeader()
	body := m.renderDetailBody()
	footer := m.renderDetailFooter()
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m StoryBankModel) renderDetailHeader() string {
	style := lipgloss.NewStyle().Bold(true).
		Foreground(m.theme.Text).Background(m.theme.Surface).
		Width(m.width).Padding(0, 2)
	if m.cursor >= len(m.stories) {
		return style.Render("Story")
	}
	s := m.stories[m.cursor]
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render(s.Title)
	tag := lipgloss.NewStyle().Foreground(m.theme.Sky).Render("[" + s.Theme + "]")
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(tag) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + tag)
}

func (m StoryBankModel) renderDetailBody() string {
	bh := m.detailBodyHeight()
	pad := lipgloss.NewStyle().Padding(0, 2)
	lines := m.detailLines()

	end := m.detailScroll + bh
	if end > len(lines) {
		end = len(lines)
	}
	visible := lines[m.detailScroll:end]

	styled := m.styleLines(visible)
	for len(styled) < bh {
		styled = append(styled, "")
	}
	return pad.Render(strings.Join(styled, "\n"))
}

func (m StoryBankModel) renderDetailFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).Background(m.theme.Surface).
		Width(m.width).Padding(0, 1)
	k := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	d := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	return style.Render(
		k.Render("↑↓") + d.Render(" scroll  ") +
			k.Render("a") + d.Render(" AI edit  ") +
			k.Render("e") + d.Render(" $EDITOR  ") +
			k.Render("Esc") + d.Render(" list"))
}

// ── AI edit view ─────────────────────────────────────────────────────

func (m StoryBankModel) aiResultHeight() int {
	h := m.height - 10
	if h < 5 {
		h = 5
	}
	return h
}

func (m StoryBankModel) viewAIEdit() string {
	var sections []string

	// Header
	headerStyle := lipgloss.NewStyle().Bold(true).
		Foreground(m.theme.Text).Background(m.theme.Surface).
		Width(m.width).Padding(0, 2)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Green).Render("AI STORY EDITOR")
	if m.cursor < len(m.stories) {
		storyTitle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("  —  " + m.stories[m.cursor].Title)
		title += storyTitle
	}
	sections = append(sections, headerStyle.Render(title))

	pad := lipgloss.NewStyle().Padding(0, 2)

	if m.aiLoading {
		loading := lipgloss.NewStyle().Foreground(m.theme.Yellow).Italic(true).
			Render("⏳ Asking Claude to refine your story...")
		sections = append(sections, pad.Render(loading))
		footer := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).Background(m.theme.Surface).
			Width(m.width).Padding(0, 1).
			Render(lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Render("Esc") +
				lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(" cancel"))
		sections = append(sections, footer)
		return lipgloss.JoinVertical(lipgloss.Left, sections...)
	}

	if m.aiResult != "" {
		// Show result
		resultLines := strings.Split(m.aiResult, "\n")
		rh := m.aiResultHeight()

		end := m.aiResultScroll + rh
		if end > len(resultLines) {
			end = len(resultLines)
		}
		visible := resultLines[m.aiResultScroll:end]
		styled := m.styleLines(visible)
		for len(styled) < rh {
			styled = append(styled, "")
		}

		label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Green).Render("✨ AI Suggestion:")
		sections = append(sections, pad.Render(label))
		sections = append(sections, pad.Render(strings.Join(styled, "\n")))

		if m.aiError != "" {
			sections = append(sections, pad.Render(lipgloss.NewStyle().Foreground(m.theme.Red).Render(m.aiError)))
		}

		k := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
		d := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		footer := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).Background(m.theme.Surface).
			Width(m.width).Padding(0, 1).
			Render(k.Render("Ctrl+A") + d.Render(" accept & save  ") +
				k.Render("Ctrl+R") + d.Render(" retry  ") +
				k.Render("↑↓") + d.Render(" scroll  ") +
				k.Render("Esc") + d.Render(" discard"))
		sections = append(sections, footer)
		return lipgloss.JoinVertical(lipgloss.Left, sections...)
	}

	// Prompt input
	promptLabel := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Render("Edit instruction:")
	sections = append(sections, pad.Render(promptLabel))

	hint := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true).
		Render("  e.g. \"make the result more quantified\", \"shorten the action section\", \"strengthen the reflection\"")
	sections = append(sections, hint)

	// Text input box
	inputStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Blue).
		Padding(0, 1).
		Width(m.width - 8)
	cursor := lipgloss.NewStyle().Background(m.theme.Blue).Foreground(m.theme.Base).Render(" ")
	inputContent := m.aiPrompt + cursor
	sections = append(sections, lipgloss.NewStyle().Padding(0, 2).Render(inputStyle.Render(inputContent)))

	if m.aiError != "" {
		sections = append(sections, pad.Render(lipgloss.NewStyle().Foreground(m.theme.Red).Render(m.aiError)))
	}

	k := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	d := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	footer := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).Background(m.theme.Surface).
		Width(m.width).Padding(0, 1).
		Render(k.Render("Enter") + d.Render(" send  ") +
			k.Render("Ctrl+U") + d.Render(" clear  ") +
			k.Render("Esc") + d.Render(" back"))
	sections = append(sections, footer)
	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}

// ── Shared markdown styling ──────────────────────────────────────────

func (m StoryBankModel) styleLines(lines []string) []string {
	styled := make([]string, len(lines))
	for i, line := range lines {
		styled[i] = m.styleLine(line)
	}
	return styled
}

func (m StoryBankModel) styleLine(line string) string {
	trimmed := strings.TrimSpace(line)

	if strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "### ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render(content)
	}
	if trimmed == "---" {
		return lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("─", m.width-6))
	}
	if strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**") {
		// Field label: **S (Situation):** value
		parts := strings.SplitN(trimmed, ":**", 2)
		if len(parts) == 2 {
			label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Render(strings.TrimPrefix(parts[0], "**") + ":")
			val := lipgloss.NewStyle().Foreground(m.theme.Text).Render(parts[1])
			return label + val
		}
	}
	return lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(line)
}
