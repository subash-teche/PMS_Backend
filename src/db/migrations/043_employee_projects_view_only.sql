-- 043: an Employee can see projects but cannot create, edit, delete or approve them (the Add / Edit buttons, the New and Edit
-- pages and the API all follow these permissions). Other roles are not touched.
UPDATE role_permissions rp
   SET can_create = false, can_edit = false, can_delete = false, can_approve = false
  FROM roles r, menus m
 WHERE rp.role_id = r.id AND rp.menu_id = m.id
   AND r.code = 'EMPLOYEE' AND m.url = '/projects';
