--[[
    config/config.lua
    -----------------
    Çekirdek yapılandırma. Buradaki her şey veridir — mantık config'te yaşamaz.
    Tüm dosyalar `LoeTelephone` global namespace'ini paylaşır.
]]

LoeTelephone = LoeTelephone or {}

LoeTelephone.Config = {
    -- Ana debug anahtarı. true iken tanılama logları basar (bkz shared/utils.lua).
    debug = false,

    ---------------------------------------------------------------------------
    -- AÇILIŞ TUŞU
    ---------------------------------------------------------------------------
    keybind = {
        mapping     = 'loe_telephone:toggle',
        description = 'Telefonu Aç/Kapat',
        defaultKey  = 'UP',   -- Yön tuşlarında Yukarı
    },

    ---------------------------------------------------------------------------
    -- SIM KART / HAT
    ---------------------------------------------------------------------------
    sim = {
        -- ox_inventory item adı (loe_724'te satılıyor).
        item = 'simcard',
        -- Numara tam olarak bu kadar haneli olmalı (yalnızca rakam).
        numberLength = 8,
        -- Bir karakterin sahip olabileceği en fazla hat (SIM) sayısı.
        maxLines = 3,
    },

    ---------------------------------------------------------------------------
    -- REHBER
    ---------------------------------------------------------------------------
    contacts = {
        -- Bir kişi adı en fazla bu kadar karakter.
        nameMaxLength = 32,
        -- Karakter başına en fazla rehber kaydı.
        maxContacts = 200,
    },

    ---------------------------------------------------------------------------
    -- MESAJLAR
    ---------------------------------------------------------------------------
    messages = {
        -- Tek mesaj en fazla bu kadar karakter.
        bodyMaxLength = 400,
        -- Bir konuşmada NUI'ye gönderilecek en fazla geçmiş mesaj.
        historyLimit = 200,
        -- Sohbet listesinde en fazla kaç konuşma gösterilsin.
        threadLimit = 100,
        -- Mesaja eklenen fotoğrafın (data URL, base64) en fazla karakter uzunluğu.
        photoMaxLength = 1500000,
        -- Devletin mesajları (polis cezası vb.) bu numaradan gelir: exports.loe_telephone:SendStateMessage.
        stateNumber = '00000911',
    },

    ---------------------------------------------------------------------------
    -- ARAMA
    --   Sinyalizasyon (çalma/kabul/red/süre) + gerçek ses (pma-voice
    --   setPlayerCall) server/main.lua'da bu ayarlarla yönetilir.
    ---------------------------------------------------------------------------
    calls = {
        -- Cevapsız sayılmadan önce çalma süresi (ms).
        ringTimeout = 25000,
        -- Arama geçmişinde en fazla kaç kayıt gösterilsin.
        historyLimit = 100,
    },

    ---------------------------------------------------------------------------
    -- TELEGRAM (App Store'dan indirilen grup mesajlaşma uygulaması)
    ---------------------------------------------------------------------------
    telegram = {
        -- Grup adı en fazla bu kadar karakter.
        groupNameMaxLength = 32,
        -- Grup mesajı en fazla bu kadar karakter.
        groupMessageMaxLength = 400,
        -- Bir grup sohbetinde NUI'ye gönderilecek en fazla geçmiş mesaj.
        groupMessageHistoryLimit = 200,
        -- "Genel Gruplar" aramasında en fazla kaç sonuç gösterilsin.
        searchLimit = 50,
        -- Karakter başına en fazla kurulabilecek grup (spam/kötüye kullanım sınırı).
        maxGroupsPerOwner = 20,
    },

    ---------------------------------------------------------------------------
    -- BANKA (App Store'dan indirilen banka uygulaması)
    --   loe_bank'ın KENDİ server callback'lerini (getData/deposit/withdraw/
    --   transfer/donate) doğrudan çağırır — loe_bank'a hiçbir değişiklik
    --   yapılmaz, bu resource yalnızca onun var olan API'sini kullanır.
    ---------------------------------------------------------------------------
    bank = {
        -- loe_bank kurulu/başlamış değilse Banka uygulaması nazikçe
        -- "kullanılamıyor" mesajı gösterir (GetResourceState ile kontrol edilir).
        resource = 'loe_bank',
        -- Banka uygulamasındaki "Cezalar" sayfası polis cezalarını bu resource'tan okur ve öder
        -- (loe_jobcreator'ın loe:fines:mine / loe:fines:pay callback'leri).
        finesResource = 'loe_jobcreator',
    },

    ---------------------------------------------------------------------------
    -- LIFEGRAM (App Store'dan indirilen sosyal medya uygulaması)
    --   Arayüz ve veri tek resource'ta: loe_lifegram. Bu telefon onun
    --   server callback'lerini (getFeed / createPost / toggleLike / ...)
    --   lib.callback ile çağırır ve React arayüzünü iframe olarak gömer
    --   (Banka ile aynı desen — loe_lifegram'a buradan müdahale edilmez).
    ---------------------------------------------------------------------------
    socialmedia = {
        -- Kurulu/başlamış değilse telefon "Lifegram şu anda kullanılamıyor."
        -- deyip ana ekrana döner (GetResourceState ile kontrol edilir).
        resource = 'loe_lifegram',
    },

    ---------------------------------------------------------------------------
    -- AIRSHARE (Kontrol Merkezi'nden) — yakındaki oyuncuya numara/fotoğraf paylaşımı
    ---------------------------------------------------------------------------
    airshare = {
        -- İki oyuncu arası en fazla bu kadar (metre/game unit) uzaklıkta paylaşım açılır.
        maxDistance = 10.0,
        -- Karşı taraf bu süre içinde yanıtlamazsa istek otomatik zaman aşımına uğrar (ms).
        requestTimeoutMs = 20000,
    },

    ---------------------------------------------------------------------------
    -- VERİTABANI TABLO ADLARI (sql/loe_telephone.sql ile aynı olmalı)
    ---------------------------------------------------------------------------
    db = {
        numbers      = 'loe_telephone_numbers',
        contacts     = 'loe_telephone_contacts',
        messages     = 'loe_telephone_messages',
        calls        = 'loe_telephone_calls',
        groups       = 'loe_telephone_groups',
        groupMembers = 'loe_telephone_group_members',
        groupMessages = 'loe_telephone_group_messages',
    },
}

