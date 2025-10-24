# Ranked Work MVP

This is a minimal, self‑contained web application that implements a **Ranked Work** productivity tracker. The goal of the app is to help you finish your daily tasks as quickly as possible and earn a rank in a competitive ladder. Eight tiers – from **Bronze** up to **Challenger** – are represented by their own custom emblems inspired by competitive video games.

> **New in this version**: The ranking system now mirrors competitive multiplayer games. Instead of accumulating total XP to rank up, you play a series of **placement matches** (days) to determine your starting tier. After placements, each day grants or deducts **League Points (LP)** based on how your performance compares to the baseline for your rank. Reaching 100 LP promotes you; dropping below 0 LP demotes you. XP is still calculated for insight and analytics but is no longer the direct driver of your rank.

## How it works

The core workflow is simple and remains unchanged:

* Build your list of tasks for the day using the **Add Task** input. You can press **Enter** to add a task quickly or use the **Add Task** button. Each entry appears in the list with its own checkbox and controls to edit, remove or reorder the task.
* When you're ready to start working, click **Start Day**. A live timer begins running (HH:MM:SS).
* Check off tasks as you complete them. The **Stop Day** button remains disabled until every task is checked, encouraging you to finish the whole list.
* Once you finish all your tasks, click **Stop Day**. The timer stops, the total time is recorded, and the app calculates XP using an inverse time curve – faster completion yields more XP. A minimum of 15 minutes and maximum of 12 hours is enforced to discourage abuse.
* The **Daily XP** value provides insight into how well you performed relative to previous days. Total XP is still tracked and shown for completeness, but your **rank progression** is now determined by placements and LP (see below).
* All data is stored in `localStorage` in your browser, so your LP, rank, and match history persist across page reloads. Use the **Reset Progress** button to clear your rank, LP and analytics history if you want to start over.

## Ranked system: placements and LP

The app borrows heavily from the ranking system of competitive games:

### Placements

* At the start of your journey you must complete **10 placement days** (matches). During placements you cannot lose LP. Each day, the app records your **Daily XP** score but does not adjust your rank.
* After you finish all placements, the app computes your average XP and assigns you a starting tier. Higher average XP (i.e. faster completion with more tasks) yields a higher starting tier. You cannot start above **Challenger** regardless of your scores.

### League Points (LP)

* Once placements are complete, each subsequent day counts as a ranked match. The app determines whether you **win** or **lose** relative to a baseline for your current rank. A good day yields a **positive** LP gain (typically between 10–30 LP); a slow day yields a **negative** LP loss. The baseline scales by rank (harder ranks expect better performance), and LP changes are capped to simulate variable gains similar to a real game.
* When your LP reaches **100**, you are **promoted** to the next rank and any extra LP carries over. If your LP drops below **0**, you are **demoted** to the previous rank and leftover LP is deducted. A notification informs you whenever you move up or down.
* LP is displayed under your stats section when you are no longer in placements. The progress bar shows your percentage toward the next promotion.

### XP (for analytics)

XP still plays an important role: it is used to evaluate your placements and to track daily performance. The **Daily XP** formula remains

\[ XP = \frac{1200}{\text{hours worked} + 0.25} \]

where the hours worked are clamped between 0.25 and 12. Finishing your tasks faster yields a higher XP score. This metric powers the analytics dashboard and gives you a quantitative measure of your productivity.

### Ranks and baselines

The eight tiers and their approximate baseline XP values are:

| Tier        | Baseline XP |
|-------------|-------------|
| Bronze      | 200         |
| Silver      | 350         |
| Gold        | 500         |
| Platinum    | 650         |
| Diamond     | 800         |
| Master      | 900         |
| Grandmaster | 950         |
| Challenger  | 1000        |

During placements your starting tier is determined by your average XP relative to these baselines. After placements your daily XP is compared with the baseline of your current tier to determine LP changes. Feel free to tweak these numbers in `main.js` to adjust difficulty.

### Feature highlights

* **League‑inspired design:** The UI embraces a dark, fantasy style reminiscent of competitive games. A swirling backdrop, golden borders and accents, and high‑contrast serif typography give it a polished, menu‑like feel.
* **Rank emblems:** Each tier (Bronze → Challenger) has its own emblem displayed beside your current rank, in the progress bar, and in the rank table.
* **Progress bar:** A horizontal bar under your stats shows how close you are to the next rank (during LP play) or how far you are through your placement matches. A tooltip appears on hover.
* **Analytics dashboard:** Beneath the XP tables, the app records every “match” (day). Each entry logs the date, hours worked, tasks completed, XP earned, and time per task. A summary shows your average hours, average tasks, and average time per task across all days.
* **Reset button:** Click **Reset Progress** to clear your total XP, rank, LP, and match history. A confirmation dialog prevents accidental resets.
* **Information tables:** Quick‑reference tables list the baseline XP threshold for each rank (see above) and the XP awarded when you finish all tasks in 1–8 hours. This helps you understand what performance corresponds to a win or loss at your current tier.

## Running the app

1. Download the **entire folder** (or the provided zip file) so that `index.html` and `main.js` remain in the same directory. The JavaScript is separated into `main.js` to avoid security restrictions on inline scripts.
2. Double‑click `index.html` or open it in your web browser via a `file:///` path. No server or build steps are required.
3. You can add tasks, start the day, and see your XP and rank update in real time.

This MVP is intentionally simple and does not implement pausing, editing tasks, or multi‑day task history beyond total XP. It’s meant as a proof of concept that you can build upon.