-- Employee codes are numbers of at least three digits starting at 001 (001, 002, ... 999, 1000): new users get the next number,
-- see nextEmpCode in users.service.js.
-- Existing EMP-#### codes are converted: EMP-1001 -> 001, EMP-1002 -> 002, ... (the old numbering started at 1001).
-- Codes that do not look like EMP-#### (e.g. EMQ099, typed by hand) are left as they are, and a code is only changed when its new
-- number is not used by another employee (001 and 1 count as the same number) - so this never fails on the unique constraint
-- and can run again.

WITH conv AS (
    SELECT id, v, CASE WHEN v < 100 THEN lpad(v::text, 3, '0') ELSE v::text END AS new_code
      FROM (SELECT id, (CASE WHEN n > 1000 THEN n - 1000 ELSE n END) AS v
              FROM (SELECT id, substring(emp_code FROM '^EMP-(\d{1,9})$')::int AS n FROM users) x
             WHERE n IS NOT NULL) y
     WHERE v > 0
)
UPDATE users u
   SET emp_code = c.new_code
  FROM conv c
 WHERE u.id = c.id
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND o.emp_code ~ '^[0-9]{1,9}$' AND o.emp_code::int = c.v)
   AND (SELECT count(*) FROM conv c2 WHERE c2.v = c.v) = 1;
