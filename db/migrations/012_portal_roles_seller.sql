UPDATE staff_users
SET role = 'seller',
    "updatedAt" = NOW()
WHERE role = 'editor';
