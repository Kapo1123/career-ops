# Story Bank — Kapo Kwok STAR+R Stories

Reusable behavioral stories drawn from real experience. Bend these to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank

---

## Stories

### [Scale / Impact] 500% Pipeline Scale — Lucid Software

**S (Situation):** Our data pipeline at Lucid Software was bottlenecked — it couldn't handle the volume our product growth demanded.
**T (Task):** Redesign it to handle 5× the load without breaking existing workflows or causing downtime.
**A (Action):** Migrated the pipeline to Databricks, restructured the distributed compute layer, and optimized memory usage to eliminate Spark Spot failures (down 50%).
**R (Result):** Pipeline capacity increased 500%. Storage and compute costs dropped 67%. Zero downtime during migration.
**Reflection:** Big performance wins almost always come from rethinking the architecture, not tuning the existing one.
**Best for questions about:** impact, scale, technical challenge, performance, data engineering, going above and beyond

---

### [Optimization / Debugging] 4× Latency Reduction — Lucid Software

**S (Situation):** Backend latency was hurting user experience. Profiling revealed memory bottlenecks in hot code paths.
**T (Task):** Reduce latency without a full rewrite — needed fast results.
**A (Action):** Identified and removed memory bottlenecks; validated with load testing before shipping.
**R (Result):** Latency dropped 4×.
**Reflection:** Sometimes the fix is simpler than the diagnosis — the hard part is knowing where to look.
**Best for questions about:** debugging, optimization, performance, ownership, attention to detail

---

### [Cost / Efficiency] Voice Agent 85% Cost Reduction — Gmango

**S (Situation):** At Gmango (AI health startup), our voice agent system had high per-call processing costs threatening unit economics.
**T (Task):** Redesign the architecture to cut costs while maintaining response quality.
**A (Action):** Rebuilt the multi-agent pipeline from scratch — reduced unnecessary API calls and optimized the inference flow.
**R (Result):** Processing costs dropped 85%. Average response time hit ~1.2 seconds. System supports 100k+ users.
**Reflection:** Cost constraints are disguised architecture problems. Solving them forces you to understand your system deeply.
**Best for questions about:** cost reduction, systems design, AI/ML, startup environment, ownership, innovation

---

### [Leadership / Team] Leading 7 Engineers 50% Faster — Gmango

**S (Situation):** As Founding Engineer at Gmango, I was responsible for engineering velocity across a 7-person team building a production AI health product.
**T (Task):** Improve development speed without sacrificing quality.
**A (Action):** Introduced GenAI-assisted development workflows and spec-driven development practices — structured templates for specs, reviews, and implementation plans.
**R (Result):** Team development speed improved 50%. Shipped faster with fewer regressions.
**Reflection:** The best way to scale a team isn't to hire faster — it's to make each engineer more effective.
**Best for questions about:** leadership, mentorship, collaboration, process improvement, technical culture

---

### [Infrastructure / Ownership] Containerization + 95% Cost Savings — BYU Library

**S (Situation):** The Harold B. Lee Library ran Django applications on bare-metal-style infrastructure with no isolation or reproducibility.
**T (Task):** Modernize the deployment setup without disrupting live services.
**A (Action):** Containerized all Django apps with Docker, set up proper environment isolation, and replaced a costly subscription service with direct API calls.
**R (Result):** Infrastructure costs dropped 50%. Subscription costs cut 95%. Daily data processing scripts ran 75% faster with zero downtime.
**Reflection:** Even small orgs benefit enormously from infrastructure basics. The improvements compounded.
**Best for questions about:** initiative, infrastructure, cost savings, working with limited resources, ownership

---

### [Product / Speed] $50K Funding via Housing Marketplace — Nebula

**S (Situation):** Nebula needed a working demo to pitch investors for their housing marketplace concept.
**T (Task):** Build a convincing, functional full-stack demo fast.
**A (Action):** Delivered a mobile-responsive housing marketplace from scratch — prioritized the flows investors would care about most.
**R (Result):** Demo helped secure $50K in funding.
**Reflection:** When speed matters, ruthless prioritization beats perfect execution.
**Best for questions about:** product sense, full-stack, startup speed, impact, prioritization

---

### [AI / Innovation] Spotify Playlist AI — Personal Project

**S (Situation):** Wanted to explore natural language interfaces for music discovery.
**T (Task):** Build a full-stack app that generates playlists from natural language prompts.
**A (Action):** Integrated Spotify API + OpenAI API with secure OAuth. Built full Django backend and frontend.
**R (Result):** Working production app — generates playlists from prompts like "upbeat songs for a morning run."
**Reflection:** Side projects where you own every layer teach you how systems actually fit together.
**Best for questions about:** passion projects, AI/ML, full-stack, self-motivation, technical curiosity

---

## Question → Story Map

| Question type | Best story |
|---|---|
| Tell me about a time you had impact | Pipeline Scale or Voice Agent Cost |
| Most technically challenging project | Pipeline Scale or 4× Latency |
| Tell me about a time you improved a process | Leadership at Gmango or Containerization |
| Tell me about a time you led others | Leadership at Gmango |
| Tell me about working under constraints | Voice Agent Cost or BYU Library |
| Tell me about a failure or learning | Any story's Reflection section |
| Most proud of | Voice Agent Cost or Pipeline Scale |
| Tell me about saving money / efficiency | Voice Agent 85% or BYU 95% subscription |
| Tell me about working on a small team | Gmango or BYU Library |
| Why do you build things? | Spotify Playlist AI |
