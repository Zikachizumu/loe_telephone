fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'loe_telephone'
author 'loe Framework'
description 'iPhone 17 Pro Max görünümlü akıllı telefon — SIM/hat, Arama, Mesajlar, Rehber, Kamera (Qbox)'
version '0.1.0'

--[[
    loe Telephone
    -----------------
    Qbox framework'ü için standalone bir akıllı telefon resource'u. Yukarı ok
    tuşuyla açılan, iPhone 17 Pro Max esintili bir NUI ile:

        - SIM / Hat    -> loe_724'ten alınan `simcard` item'ı kullanılınca
                          oyuncu 8 haneli numarayı kendi belirler. Karakter
                          başına en fazla 3 hat; aynı anda yalnızca 1'i aktif
                          (klasik çift-SIM "hat değiştir" mantığı).
        - Arama        -> hat bazlı sesli arama: çalma / kabul / reddet / süre
                          server/main.lua'da yönetilir; gerçek ses aktarımı
                          resources/[core]/pma-voice'un `setPlayerCall` export'u
                          ile sağlanır (pma-voice kurulu değilse ses gitmez ama
                          arama akışı/geçmişi yine çalışır).
        - Mesajlar     -> numaralar arası SMS, sunucuda kalıcı, karşı taraf
                          çevrimdışı olsa da bekler.
        - Rehber       -> karaktere bağlı (hatlardan bağımsız) isim+numara.
        - Kamera/Galeri -> GTA Online tarzı tam ekran kamera (CreateCam); kare
                          NUI'de FiveM game-view dokusundan yakalanır.
                          Galeri oyuncunun kendi NUI tarayıcısında (IndexedDB)
                          yerel saklanır — sunucuya/Discord'a yüklenmez.

    Server-authoritative: numara doğrulama/benzersizlik, hat sahipliği, mesaj
    ve arama yönlendirmesi tamamen server'da yapılır. Client'tan gelen hiçbir
    numara/sahiplik bilgisine güvenilmez.

    Dependencies (bu resource tarafından ASLA değiştirilmez):
        - qbx_core     (oyuncu / CreateUseableItem / offline-safe player lookup)
        - ox_lib       (NUI callback, inputDialog, notify)
        - ox_inventory (simcard item verme/alma + doğrulama)
        - oxmysql      (numara / rehber / mesaj / arama kalıcılığı)

    Mimari (loe_724 / loe_bank ile aynı):
        config/  -> saf veri: tuş, SIM/hat kuralları, tablo adları
        shared/  -> client + server ortak yardımcılar (numara doğrulama/format)
        client/  -> NUI köprüsü, kamera vizörü, arama/mesaj bildirimleri
        server/  -> SIM kayıt akışı + hat/rehber/mesaj/arama CRUD (server-authoritative)
        web/     -> NUI (index.html / css / js) — iPhone 17 Pro Max görünümü
        sql/     -> tablolar (server ilk başlarken de otomatik kurulur)
]]

dependencies {
    'qbx_core',
    'ox_lib',
    'ox_inventory',
    'oxmysql',
}

-- ox_lib her şeyden önce yüklenmeli.
shared_scripts {
    '@ox_lib/init.lua',
    'config/config.lua',
    'shared/utils.lua',
}

client_scripts {
    'client/main.lua',
}

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server/main.lua',
}

ui_page 'web/index.html'

files {
    'web/index.html',
    'web/css/style.css',
    'web/js/app.js',
    'web/img/wallpaper-home.jpg',
    'web/img/icon-phone.png',
    'web/img/icon-messages.png',
    'web/img/icon-contacts.png',
    'web/img/icon-settings.png',
    'web/img/icon-camera.png',
    'web/img/icon-gallery.png',
    'web/img/icon-appstore.png',
    'web/img/icon-telegram.png',
    'web/img/icon-lifegram.png',
    'web/img/icon-marketplace.png',
}

