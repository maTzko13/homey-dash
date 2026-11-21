-- Optional, Omarchy/Hyprland: dashboard as a floating web-app window.
-- Open it e.g. with `omarchy-launch-webapp https://home.example.com` on a key binding.
-- Chromium-based browsers name --app windows chrome-<host>__-<profile>; replace the host below.
-- 1160 px is just above the 1100 px breakpoint, so the dashboard shows three columns.
o.window("^chrome-home\\.example\\.com__.*$", {
  float = true,
  center = true,
  size = { 1160, 760 },
  tag = "-default-opacity",
  opacity = "1 1",
})
