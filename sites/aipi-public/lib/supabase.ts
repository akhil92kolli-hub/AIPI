"use client";

import { createClient } from "@supabase/supabase-js";

// Share auth refresh state across all cloud surfaces in this browser.
// Privileged credentials stay in the Worker.
export const supabase = createClient(
  "https://zwffmaxjbzuazopvorkv.supabase.co",
  "sb_publishable_usDgSv1ntGAwQVpk2lenYQ_E06i1WYy",
);
