ALTER TABLE backup_settings ALTER COLUMN schedule_time SET DEFAULT '13:00';

UPDATE backup_settings SET schedule_time='13:00',updated_at=now()
WHERE schedule_time='20:00';
