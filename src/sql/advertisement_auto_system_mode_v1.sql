BEGIN;
ALTER TABLE public.shadow_advertisement_rotation_settings
DROP CONSTRAINT IF EXISTS shadow_advertisement_rotation_settings_mode_check;
ALTER TABLE public.shadow_advertisement_rotation_settings
ADD CONSTRAINT shadow_advertisement_rotation_settings_mode_check
CHECK (mode IN ('manual', 'auto', 'auto_system'));
COMMIT;
