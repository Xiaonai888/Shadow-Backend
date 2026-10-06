CREATE TABLE IF NOT EXISTS public.task_center_daily_story_assignments (
  assignment_date date PRIMARY KEY,
  new_story_id text NOT NULL,
  completed_story_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_center_daily_story_assignments_different_stories_check
    CHECK (new_story_id <> completed_story_id)
);

ALTER TABLE public.task_center_daily_story_assignments ENABLE ROW LEVEL SECURITY;
