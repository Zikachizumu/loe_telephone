-- loe_telephone — tablolar
-- --------------------------------------------------------------------------
-- server/main.lua bu tabloları ilk başlarken `CREATE TABLE IF NOT EXISTS` ile
-- otomatik kurar; bu dosya elle kurmak / şemayı görmek isteyenler içindir.
--
-- Collation qbx `players` tablosuyla AYNI (utf8mb4_unicode_ci) olmalı; aksi
-- halde citizenid karşılaştırmaları "Illegal mix of collations" hatası verir.
-- (server/main.lua yanlış collation ile açılmış tabloları açılışta düzeltir.)

-- NUMARALAR (SIM / hatlar)
--   Her satır bir hat. Karakter başına en fazla Config.sim.maxLines (3) satır.
--   number: oyuncunun 724'te simcard kullanınca kendi belirlediği 8 hane,
--   sunucu genelinde benzersiz (UNIQUE). active: o an telefonun kullandığı
--   hat — karakter başına aynı anda yalnızca 1 satırda 1 olabilir (uygulama
--   katmanında garanti edilir, bkz server/main.lua setActiveNumber).

CREATE TABLE IF NOT EXISTS `loe_telephone_numbers` (
    `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `citizenid`  VARCHAR(50)  NOT NULL,
    `number`     VARCHAR(8)   NOT NULL,
    `active`     TINYINT(1)   NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_number` (`number`),
    KEY `idx_citizenid` (`citizenid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- REHBER
--   Hatlardan BAĞIMSIZ, karaktere bağlı. Bir hat/SIM değişse de rehber kalır.
--   (citizenid, number) UNIQUE -> aynı numara aynı rehbere iki kez eklenemez.

CREATE TABLE IF NOT EXISTS `loe_telephone_contacts` (
    `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `citizenid`  VARCHAR(50)  NOT NULL,
    `number`     VARCHAR(8)   NOT NULL,
    `name`       VARCHAR(64)  NOT NULL,
    `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_citizenid` (`citizenid`),
    UNIQUE KEY `uniq_owner_number` (`citizenid`, `number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MESAJLAR (SMS)
--   Numaralar arası; alıcı çevrimdışı olsa da satır oluşur (banka havalesi
--   mantığıyla aynı — teslim, karşı taraf girince/hat aktifleşince görülür).
--   read_at: alıcı konuşmayı açınca doldurulur (okunmamış sayacı için NULL).

CREATE TABLE IF NOT EXISTS `loe_telephone_messages` (
    `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `from_number` VARCHAR(8)   NOT NULL,
    `to_number`   VARCHAR(8)   NOT NULL,
    `body`        VARCHAR(400) NOT NULL,
    `photo_data`  LONGTEXT     NULL DEFAULT NULL,
    `location`    VARCHAR(64)  NULL DEFAULT NULL,
    `read_at`     TIMESTAMP    NULL DEFAULT NULL,
    `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_from` (`from_number`),
    KEY `idx_to_read` (`to_number`, `read_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ARAMA GEÇMİŞİ
--   status: answered | missed | declined. duration: yalnızca answered'da (sn).
--   Gerçek ses aktarımı (pma-voice) henüz yok — bu tablo yalnızca sinyalizasyon
--   sonucunu (kim, ne zaman, ne oldu) kalıcı tutar.

CREATE TABLE IF NOT EXISTS `loe_telephone_calls` (
    `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    `from_number` VARCHAR(8)    NOT NULL,
    `to_number`   VARCHAR(8)    NOT NULL,
    `status`      VARCHAR(16)   NOT NULL,
    `duration`    INT UNSIGNED  NULL DEFAULT NULL,
    `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_from` (`from_number`),
    KEY `idx_to` (`to_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TELEGRAM GRUPLARI (App Store'dan indirilen Telegram uygulaması)
--   type: public (arama ile herkese görünür) | private (yalnızca davet kodu).
--   invite_code: tüm gruplar için üretilir (public gruplar da kod ile
--   katılınabilir), 8 karakter, benzersiz.

CREATE TABLE IF NOT EXISTS `loe_telephone_groups` (
    `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name`         VARCHAR(32)  NOT NULL,
    `type`         ENUM('public','private') NOT NULL DEFAULT 'public',
    `invite_code`  VARCHAR(10)  NOT NULL,
    `owner_number` VARCHAR(8)   NOT NULL,
    `created_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_invite_code` (`invite_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- GRUP ÜYELERİ

CREATE TABLE IF NOT EXISTS `loe_telephone_group_members` (
    `id`        INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `group_id`  INT UNSIGNED NOT NULL,
    `number`    VARCHAR(8)   NOT NULL,
    `joined_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_group_number` (`group_id`, `number`),
    KEY `idx_number` (`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- GRUP MESAJLARI

CREATE TABLE IF NOT EXISTS `loe_telephone_group_messages` (
    `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `group_id`    INT UNSIGNED NOT NULL,
    `from_number` VARCHAR(8)   NOT NULL,
    `body`        VARCHAR(400) NOT NULL,
    `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_group` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
