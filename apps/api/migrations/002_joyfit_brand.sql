UPDATE settings
SET name='悦体健身', updated_at=now()
WHERE id=1
  AND name IN ('你的健身房（待配置）','原力健身 · 演示门店');
