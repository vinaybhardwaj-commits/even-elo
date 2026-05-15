import { redirect } from "next/navigation";

/**
 * Root route — EPI.0a.
 *
 * v1's leaderboard lives at `/surgical-elo` now. Until EPI.0b ships the new
 * Dashboard home at `/home`, the root redirects to the v1 ELO leaderboard.
 *
 * EPI.0b will replace this with an auth-conditional redirect:
 *   logged-in → /home, logged-out → /auth/login.
 */
export default function RootRedirect() {
  redirect("/surgical-elo");
}
