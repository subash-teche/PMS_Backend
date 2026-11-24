-- Task types of the digital team (they were the "Task types" list of the old Task Management app), in their task groups.
-- Idempotent: groups and types that exist are left as they are (same approach as 036).
--
--   Content Creation    : Blog, Greet, Newsletter, Post, Reel, TL
--   Digital Marketing   : G-Ads, SEO                         (new group: nothing existing fits)
--   Project Management  : Report
--   Development         : Web, SWDEV
--   Maintenance         : SWAMC

INSERT INTO task_groups (name)
SELECT v.name FROM (VALUES ('Content Creation'), ('Digital Marketing'), ('Project Management'), ('Development'), ('Maintenance')) AS v(name)
 WHERE NOT EXISTS (SELECT 1 FROM task_groups g WHERE lower(g.name) = lower(v.name));

INSERT INTO task_types (task_group_id, name)
SELECT g.id, v.type_name
  FROM (VALUES
          ('Content Creation',   'Blog'),
          ('Content Creation',   'Greet'),
          ('Content Creation',   'Newsletter'),
          ('Content Creation',   'Post'),
          ('Content Creation',   'Reel'),
          ('Content Creation',   'TL'),
          ('Digital Marketing',  'G-Ads'),
          ('Digital Marketing',  'SEO'),
          ('Project Management', 'Report'),
          ('Development',        'Web'),
          ('Development',        'SWDEV'),
          ('Maintenance',        'SWAMC')
       ) AS v(group_name, type_name)
  JOIN task_groups g ON lower(g.name) = lower(v.group_name)
 WHERE NOT EXISTS (SELECT 1 FROM task_types t WHERE t.task_group_id = g.id AND lower(t.name) = lower(v.type_name));

-- the new group is project work like the other groups (035): link it to the same task categories as Content Creation
INSERT INTO task_category_groups (task_category_id, task_group_id)
SELECT l.task_category_id, ng.id
  FROM task_category_groups l
  JOIN task_groups cg ON cg.id = l.task_group_id AND lower(cg.name) = 'content creation'
  CROSS JOIN task_groups ng
 WHERE lower(ng.name) = 'digital marketing'
ON CONFLICT DO NOTHING;
