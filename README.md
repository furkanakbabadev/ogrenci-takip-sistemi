# Ogrenci Takip Sistemi

Google Sheets uzerinde veri tutan, okul konumuna 1 km'den uzakta giris/cikis yaptirmayan ve ogrenciyi ilk kullandigi cihaza baglayan basit takip sistemi.

## Ozellikler

- Ogrenci giris/cikis kaydi
- Google Sheets'e otomatik yazma
- Her ogrenci icin ayri sheet olusturma
- Gunluk toplam calisma saatini hesaplama
- 1 km konum siniri
- Cihaz baglama: ogrenci ilk giriste rastgele uretilen cihaz kimligine baglanir
- Sifre paylasimini zorlastirma: farkli cihazdan giris engellenir
- Admin panelinde ogrenci ekleme ve son kayitlari gorme

## Kurulum

1. Google Cloud'da bir Service Account olusturun.
2. Google Sheets API'yi aktif edin.
3. Service Account e-posta adresini Google Sheet dosyaniza `Editor` olarak ekleyin.
4. `.env.example` dosyasini `.env` olarak kopyalayip degerleri doldurun.
5. Calistirin:

```bash
npm start
```

Sonra tarayicida `http://localhost:3000` adresini acin.

## GitHub ve Render ile Yayina Alma

1. Projeyi GitHub'a yukleyin.
2. Render Dashboard'da `New` > `Web Service` secin.
3. GitHub reposunu baglayin.
4. Ayarlar:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: `Free`
5. Environment Variables bolumune `.env` icindeki degerleri tek tek ekleyin.
6. `Create Web Service` ile deploy edin.

Render canli ortamda `PORT` degiskenini kendi verir. Uygulama bunu otomatik kullanir.

## Google Sheet Yapisi

Uygulama su sheetleri otomatik olusturur:

- `Students`: ogrenci bilgileri ve bagli cihaz
- `Events`: tum giris/cikis hareketleri
- `Student_<ogrenci_kodu>`: ilgili ogrencinin hareketleri ve gunluk toplam sureleri

## Konum Ayarlari

- `ALLOWED_RADIUS_METERS`: Okul merkezinden izin verilen en uzak mesafe. 1 km icin `1000` yazin.
- `MAX_ACCURACY_METERS`: Cihazin bildirdigi GPS hassasiyeti limiti. Kapali alanlarda hata azalmasi icin `300` iyi bir baslangictir.

## Onemli Guvenlik Notu

Tarayici konumu ve localStorage tabanli cihaz kimligi ucretsiz web teknolojileriyle yuzde yuz guvenli degildir. Bu sistem pratikte sifre paylasimini ve uzaktan giris/cikisi zorlastirir. Daha yuksek guvenlik icin okul Wi-Fi dogrulamasi, QR/NFC noktalari, mobil uygulama tabanli cihaz dogrulama veya MDM gerekir.
