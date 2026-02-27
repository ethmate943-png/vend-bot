# MoovMart Landing — 5 Section Layout Variants

Choose one variant (or mix) for **How it works**, **Features**, **For Buyers**, **Social proof**, and **Pricing/FAQ**. Each is modern, contemporary, and works with your existing Tailwind + Host Grotesk setup.

---

## Variant A — Bento grid (current)

**Look:** Dense grid of same-size or mixed-size cards; borders between cells; hover lift.

**Best for:** Maximum information density, “product dashboard” feel.

- **How it works:** 4 equal columns (01–04) in one row.
- **Features:** 3-column grid with 2-span for hero feature; rest single cells.
- **For Buyers:** Full-width centered block with search bar.
- **Social proof:** 2 columns: one large quote card, one 2×2 grid + full-width strip.
- **Pricing:** 2×2 category grid inside one card.

**Classes to keep:** `grid`, `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`, `gap-px`, `bento-card`, `border border-white/10`, `p-10` / `p-12`.

---

## Variant B — Vertical timeline / single column

**Look:** One column; each step/feature is a horizontal bar with number on the left, content on the right; thin vertical line connecting items.

**Best for:** Clear reading order, mobile-first, “onboarding” feel.

- **How it works:** 4 rows. Left: circle with “01”–“04”. Right: title + short text. Connector line between circles.
- **Features:** Same pattern: icon + title + description per row; optional alternating icon left/right.
- **For Buyers:** Same centered CTA block; can add a short 3-step “Search → Pay → Receive” timeline below.
- **Social proof:** Stacked quote cards (full width), then one row of two stats.
- **Pricing:** Single column list of categories with % on the right; one line per category.

**Structure:**  
`flex flex-col gap-0` → each item `flex flex-row gap-6 items-start` with `border-l-2 border-[#25D366]/30 pl-8` and a `w-12 h-12 rounded-full` number/icon.

---

## Variant C — Alternating left/right blocks

**Look:** Large sections alternate: image/visual left, text right; next section text left, visual right. Full-width rows.

**Best for:** Storytelling, less “UI”, more editorial.

- **How it works:** 4 full-width rows. Odd: number + title + text on left, empty or icon on right. Even: swap.
- **Features:** One big block per feature (icon, title, description); alternate alignment (text-left vs text-right).
- **For Buyers:** One full-width block: headline, body, search bar; optional illustration or icon on one side.
- **Social proof:** One quote per row; avatar/name on the opposite side to the quote.
- **Pricing:** One row: copy left, 2×2 % grid right; next section could be “Why no monthly fee” with reversed layout.

**Classes:** `flex flex-col md:flex-row gap-12 items-center`, `md:flex-row-reverse` for alternate, `max-w-2xl` for text block, `flex-1` for balance.

---

## Variant D — Horizontal scroll / card strip

**Look:** Sections are a single row of cards; user scrolls horizontally (or sees a subtle scroll hint). One card in focus, others peeking.

**Best for:** Mobile-friendly “swipe”, product-feature “carousel” feel.

- **How it works:** 4 cards in `flex overflow-x-auto snap-x snap-mandatory`; each card `min-w-[280px] snap-center` with step number, title, text.
- **Features:** Same: 6–8 feature cards in a horizontal strip; optional dots or “scroll” CTA.
- **For Buyers:** Centered block stays; below it, 3 “Search / Pay / Receive” cards in a short horizontal strip.
- **Social proof:** 2–3 quote cards in a row, horizontal scroll.
- **Pricing:** 4 category cards in a row (Electronics 3%, Food 4%, etc.) with horizontal scroll.

**Classes:** `flex overflow-x-auto gap-4 pb-4 snap-x snap-mandatory`, child `flex-shrink-0 w-[85vw] max-w-md snap-center`, hide scrollbar with `scrollbar-hide` or custom CSS.

---

## Variant E — Minimal list + big type

**Look:** Very little decoration; large headings, short body text, thin dividers or spacing. No cards, just typography and one accent color.

**Best for:** Trust, clarity, “we don’t need to shout”; works well with lots of white (or dark) space.

- **How it works:** One heading “Set up in 60 seconds.” Then 4 lines: “1. Enter number” / “2. Add products” / “3. Share link” / “4. Automate” with one sentence each; no boxes.
- **Features:** One list: icon (small) + feature name + one line; vertical divider or spacing between.
- **For Buyers:** Headline + one paragraph + search bar; no extra cards.
- **Social proof:** One pull quote, one line attribution; then “5m avg setup · 24h avg payout” as a single line.
- **Pricing:** “Free to start. We only earn when you do.” Then a simple list: “Electronics 3% · Food 4% · …” or one line per category.

**Classes:** `space-y-6` or `divide-y divide-white/10`, `text-4xl md:text-6xl` for section titles, `text-lg text-neutral-400` for body, minimal borders; avoid `bg-[#0a0a0a]` boxes or use very subtle `bg-white/[0.02]`.

---

## Quick comparison

| Variant | Density | Mobile | Vibe |
|--------|--------|--------|------|
| **A — Bento** | High | Good | Product / dashboard |
| **B — Timeline** | Medium | Excellent | Onboarding / linear |
| **C — Alternating** | Medium | Good | Editorial / story |
| **D — Horizontal scroll** | Medium | Excellent | Carousel / app-like |
| **E — Minimal list** | Low | Excellent | Trust / minimal |

Recommendation: use **one** variant for the whole page for consistency (e.g. all B or all E), or use **B** for “How it works”, **A** for “Features”, **E** for “Pricing” if you want to mix.

After you choose, the sections in `public/landing.html` can be updated to match the selected variant(s).
