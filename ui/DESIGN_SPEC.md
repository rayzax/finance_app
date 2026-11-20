# Alpine Reserve: UI design spec

Option A from the design review, approved by Drew. It's a premium private-bank look with a nature feel: pine-black, champagne gold, and an elegant serif for the money.

- **Live canvas:** https://claude.ai/artifact/9yKkcyydboq5wMCRQaWQMx (row A)
- **Tokens:** `tokens.css`
- **Mockups:** `mockups/home.dc.html`, `activity.dc.html`, `budgets.dc.html`

**How to read the mockups.** They use a templating format (`<x-dc>`, `{{holes}}`, `<sc-for>`, `<sc-if>`). They won't run on their own, because they need the canvas runtime (`support.js`). Treat them as **pixel-exact markup references**: every size, color, radius and spacing is inline in `style="…"`. The sample data in each file's `<script>` block shows the shape of the data. All numbers and merchants are fake.

## Principles

1. **iPhone first.** Design and test at 390×844 (iPhone 14/15/16) and 430×932 (Pro Max). Desktop is a centered phone-width column (`max-width: 480px`) and nothing more.
2. **Quiet luxury.** Lots of dark space, thin gold hairlines, and serif numerals for money. No gradients, glows, emoji or drop shadows. Gold is the only accent. Green is used only for gains and income.
3. **Money is the hero.** Big balances use the display serif. Every amount in a list uses Inter with `font-variant-numeric: tabular-nums`.
4. **Accessible as drawn.** Text meets 4.5:1 contrast. Touch targets are at least 44pt. Use real `<button>`/`<a>`/`<input>` elements. Icon-only buttons get an `aria-label`. Decorative SVGs get `aria-hidden`.

## iPhone / PWA specifics (required)

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, `theme-color=#0C1411`, plus a `manifest.webmanifest` with `display: standalone` and a 180px `apple-touch-icon`. The icon is a gold mountain-ridge line on pine-black.
- Safe areas:
  - Screen top padding: `max(56px, env(safe-area-inset-top) + 12px)`.
  - Tab bar: `padding-bottom: env(safe-area-inset-bottom)`.
  - Scroll content: bottom padding equal to the tab bar height plus the inset.
- Inputs are at least 16px, so iOS doesn't zoom on focus. Use `type="search"`, `inputmode="decimal"` for money, and `autocomplete="current-password"` on login.
- Turn off `-webkit-tap-highlight-color`. Show press states with an opacity of about 0.7 or a subtle tint, never hover-only.
- Use `overscroll-behavior: none` on the body, so the dark page doesn't rubber-band into white.
- Pull-to-refresh on Home and Activity triggers a sync. This is a custom gesture, because the browser's pull-to-refresh isn't available in standalone mode.
- Detail views and editors are **bottom sheets**: 20px top radius, a drag handle, and the backdrop is `rgba(0,0,0,.5)`.
- Honor `prefers-reduced-motion`.

## Layout skeleton

- **Screen:** background `--bg`, side padding 20px, sections 16px apart (18px on Home).
- **Tab bar:** fixed at the bottom with four equal columns: **Home · Activity · Budgets · Wealth**.
  - Background `--bg-bar` with a 1px `--line` top border.
  - 22px stroke icons (1.7 stroke width, round caps and joins) with 11px labels.
  - Active tab: gold at weight 600. Inactive: `--muted` at weight 500. The active tab sets `aria-current="page"`.
- **Card:** background `--surface`, 1px `--line` border, `--r-card` radius, 16px horizontal padding. Card headers are 44px tall: an h2 in the display serif at 21px/600 on the left, a gold text link on the right.
- **Row:** 12px gap.
  - Leading icon tile: 36×36, radius 12, `--gold-tint` background, 18px gold stroke icon.
  - Middle: a 15/500 title over a 12px `--muted` subtitle.
  - Trailing: the amount at 15/600 tabular.
  - 1px `--line-soft` divider on top.
- **Uppercase label:** 11px, letter-spacing .14–.16em, weight 600, gold.
- **Segmented control / chips:** `--surface-2` track with a 1px line and radius 14. Items are 44px tall. Selected: gold fill with `#0C1411` text at 600. Unselected: transparent with `--muted-2` text.

## Icons (24×24 viewBox, stroke)

| Use | Path(s) |
|---|---|
| Home | `M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z` |
| Activity | `M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01` |
| Budgets | `M21 12A9 9 0 1 1 12 3v9z` + `M15 3.5A9 9 0 0 1 20.5 9H15z` |
| Wealth | `M3 21h18M4 10h16M12 3 3 8h18zM6 10v8M10 10v8M14 10v8M18 10v8` |
| Cash | `M3 7a2 2 0 0 1 2-2h13v4` + `M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z` + `M16 14h.01` |
| Investments | `M3 17l6-6 4 4 8-8` + `M15 7h6v6` |
| Retirement (sprout) | `M12 21v-9` + `M12 12C12 7 8 5 4 5c0 4 3 7 8 7z` + `M12 14c0-4 3-6 8-6 0 4-3 6-8 6z` |
| Credit card | `rect x3 y5 w18 h14 rx2` + `M3 10h18` |
| Search | `circle 11,11 r7` + `M20 20l-3.5-3.5` |
| Export | `M12 3v12` + `M7 10l5 5 5-5` + `M4 21h16` |
| Chevron down | `M6 9l6 6 6-6` |

Lucide is an acceptable source for anything else, at the same stroke weight.

## Screens

### Home (`home.dc.html`)

1. **Header:** the date (13px, muted) over "Good evening, Drew". The greeting is in the display serif at 27/600 and changes with the time of day. On the right is a 44px round avatar button with the initials "DS" (gold outline) that opens the Settings sheet.
2. **Net worth:**
   - Label "NET WORTH".
   - The amount in the display serif at 54/500. Cents are 26px and muted.
   - Delta line: a green value (`+$3,214.08`) followed by a muted period ("past month").
3. **Chart:** the net-worth line, 350×112, with a 2px gold stroke and a faint baseline. The end point is a hollow circle with a `--gold-hi` stroke. It sits behind two faint gold mountain-ridge lines that are decoration only. Press and drag shows a scrub tooltip with the date and value.
4. **Range control:** 1M · 3M · 1Y · All. It changes the chart path and the delta.
5. **Accounts card:** grouped rows for Cash, Investments, Retirement and Credit cards. Add Loans and Other only when they exist. Each row shows the group total and a subtitle (account count, a type summary, or "Due Dec 4" for credit). Liabilities show as `−$` in `--liability`. "Link account" opens Plaid Link. Tapping a row opens Wealth, filtered to that group.
6. "Updated 12 min ago" goes in small muted text under the card or in the header. Pull-to-refresh syncs.

### Activity (`activity.dc.html`)

1. The title "Activity" (display serif, 34/600) and a round export button (CSV).
2. Two stat tiles: **SPENT · NOV** and **EARNED · NOV** (green), in the display serif at 26/600.
3. Search field, 46px tall, with a magnifier icon and a hidden label.
4. Filter chips: All · Spending · Income · Transfers.
5. Transactions grouped by day (Today, Yesterday, then "Tue, Nov 17"), with 11px uppercase muted group headers. Each row has:
   - a 38px circle avatar: the merchant logo if Plaid has one, otherwise the serif initial in gold on a gold outline;
   - the merchant name over the category;
   - the amount, green with a `+` for income.

   Pending transactions get a small "Pending" tag.
6. Infinite scroll. Tapping a row opens a **transaction sheet** showing the merchant, amount, date, account and category. The category can be changed, and you choose whether to apply the change to future transactions from that merchant.

### Budgets (`budgets.dc.html`)

1. The title "Budgets" and a month picker pill ("November ⌄").
2. **Overview card:** a 124px ring (10px stroke, gold on `--track`, round cap) with the percent in the serif and "spent" under it. Next to it: "LEFT TO SPEND", the amount in the serif at 36, and "$3,182 of $4,500 · 11 days left".
3. **Categories card:** each row shows the name, then "$spent / $limit" (muted) or "Over by $X" (`--over-text`), then a 6px bar. The bar is gold, or `--over` when over budget, and its width is capped at 100%. "Edit" opens a sheet to set monthly limits.
4. **Cash flow card:** "CASH ON <date + 30d>" with the projected cash in the serif, plus "Forecast · N bills, M paydays ahead". On the right is a mini bar chart: past weeks in ivory at 55%, projected weeks in gold. Tapping it opens a forecast sheet listing upcoming bills and paydays.

### Wealth (not mocked; build it in the same language)

- Title "Wealth" and the net worth total, with assets and liabilities shown as two stat tiles.
- One card per group, listing each account: an institution initial or logo tile, the account name, "Institution ··1234", and the balance. Credit accounts also show utilization (balance ÷ limit) as a thin bar.
- A **Connections** card listing each linked institution with its status: OK (muted "Synced 2h ago"), Needs login (a gold "Reconnect" button that opens Plaid Link in update mode), or Error. Swipe or tap to remove.
- The primary gold button "Link an account".

### Login (not mocked)

- Full-screen `--bg` with the mountain ridge lines across the top third.
- The word "Reserve" in the display serif at 44.
- One password field (16px, `--surface-2`, radius 14) and a full-width gold "Unlock" button (44px+, `#0C1411` text). Errors use `--over-text`.

### Settings sheet (from the avatar)

Sync now (with the last-synced time), Connections (opens Wealth), Appearance (only Alpine for now), Log out.

## Motion

- Sheets slide up in 240ms on `cubic-bezier(.2,.8,.2,1)`.
- On first render, the chart line draws in over 600ms with `stroke-dashoffset`.
- Tab switches don't animate.
- Numbers don't count up, except the net-worth hero, which may count up once per session.

## Empty / loading / error states

- **Loading:** skeleton bars at `--surface-2`, matching the row heights, with no spinners on the main screens.
- **No accounts:** Home shows a centered card: the serif headline "Link your first account", a muted line, and the gold button that opens Plaid Link.
- **Errors:** a small inline banner in `--over-text` on a `--surface` card, with a retry button.
