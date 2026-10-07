-- Branch 3 (Pollachi): pincode added to the printed address.
BEGIN;
UPDATE public.store_settings
SET address = 'Take250 Women''s Wear, No. 853, Bhagvati Palayam, Pollachi - 642109', updated_at = now()
WHERE branch_id = 'pos3';
COMMIT;