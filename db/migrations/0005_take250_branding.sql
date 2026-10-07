-- Take250 branding: branch labels / logos and each branch's Store Settings (shop name, owner, phones, email, address, Instagram).
-- Everything here is DATA: the app reads it from /api/auth/me and /api/settings, so a later change is an edit in
-- Admin > Store Settings, not a code change. Logo files are public/yg-logo-pos1..3.png (built by scripts/make-branding-assets.mjs).
BEGIN;

-- neutral column defaults for any branch added later (the old ones named a previous business)
ALTER TABLE public.store_settings
  ALTER COLUMN name SET DEFAULT 'TAKE250',
  ALTER COLUMN phone SET DEFAULT '',
  ALTER COLUMN email SET DEFAULT '',
  ALTER COLUMN address SET DEFAULT '',
  ALTER COLUMN website_url SET DEFAULT '';

UPDATE public.branches SET short_label = 'Take250 Karanthai',       subtitle = 'Dress & Footwear', logo_url = '/yg-logo-pos1.png' WHERE id = 'pos1';
UPDATE public.branches SET short_label = 'Take250 Kinathukadavu',   subtitle = 'Dress & Footwear', logo_url = '/yg-logo-pos2.png' WHERE id = 'pos2';
UPDATE public.branches SET short_label = 'Take250 Pollachi',        subtitle = 'Women''s Wear',    logo_url = '/yg-logo-pos3.png' WHERE id = 'pos3';

-- Branch 1: new opening shop, Karanthai (Thanjavur)
UPDATE public.store_settings SET
  name = 'Take250 Shop - Dress & Footwear', owner_name = 'M. Ramkumar', business_type = 'Dress & Footwear',
  phone = '+91 88831 73358, +91 73393 44149', email = 'take250shop@gmail.com',
  address = 'Take250 Shop, Thanjavur Main Road, Karanthai - 613002',
  instagram_id = 'take.250shop', website_url = 'https://www.instagram.com/take.250shop/', logo_url = NULL, updated_at = now()
WHERE branch_id = 'pos1';

-- Branch 2: already open shop, Kinathukadavu (Coimbatore)
UPDATE public.store_settings SET
  name = 'Take250 Shop - Dress & Footwear', owner_name = 'M. Ramkumar', business_type = 'Dress & Footwear',
  phone = '+91 88831 73358, +91 73393 44149', email = 'take250shop@gmail.com',
  address = 'Take250 Shop, Coco Town, Kinathukadavu, Pollachi Main Road, Coimbatore - 642109',
  instagram_id = 'take.250shop', website_url = 'https://www.instagram.com/take.250shop/', logo_url = NULL, updated_at = now()
WHERE branch_id = 'pos2';

-- Branch 3: Pollachi, women's wear (the contact numbers and email are the shared Take250 ones until it gets its own)
UPDATE public.store_settings SET
  name = 'Take250 Women''s Wear', owner_name = 'M. Ramkumar', business_type = 'Women''s Wear',
  phone = '+91 88831 73358, +91 73393 44149', email = 'take250shop@gmail.com',
  address = 'Take250 Women''s Wear, No. 853, Bhagvati Palayam, Pollachi',
  instagram_id = 'take.250shop', website_url = 'https://www.instagram.com/take.250shop/', logo_url = NULL, updated_at = now()
WHERE branch_id = 'pos3';

COMMIT;