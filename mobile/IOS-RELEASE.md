# Paglabas ng GeoAttend sa iPhone (TestFlight at App Store)

Para ito sa pag-install ng app sa iPhone ng lahat ng empleyado (mga 1,500). Hindi kailangan ng Mac, dahil sa cloud ng Expo (EAS) ginagawa ang iOS build.

## 0. Bago magsimula

Kailangang ayusin muna ang mga ito, kung hindi ay ire-reject ng Apple ang app o hindi ito gagana sa mga empleyado:

- **Permanenteng HTTPS server.** Sa ngayon, devtunnels URL ang `extra.apiBaseUrl` sa `app.json` (`https://pq2qwb2x-3000.asse.devtunnels.ms/api`). Pansamantala lang ito at namamatay kapag nakapatay ang PC. Palitan ito ng totoong domain, halimbawa `https://geoattend.cspc.edu.ph/api`, bago mag-build. Hindi tinatanggap ng iOS ang `http://`.
- **Privacy Policy URL.** Hinihingi ito ng App Store Connect, lalo na at kumukuha ang app ng location at mukha. Puwede itong simpleng page sa server, halimbawa `https://.../privacy`.
- **Demo account para sa Apple reviewer.** Isang test employee na kayang mag-login at nakarehistro na sa isang event na bukas, para masubukan nila ang time-in.

## 1. Apple Developer Program (isang beses lang)

1. Kumuha ng **D-U-N-S Number** para sa CSPC. Libre ito at inaabot ng mga 1–2 linggo: https://developer.apple.com/enroll/duns-lookup/
2. Mag-enroll bilang **Organization**, hindi Individual: https://developer.apple.com/programs/enroll/
   - Gamitin ang Apple ID na pag-aari ng opisina, hindi personal na account.
3. **Fee waiver.** Habang nag-e-enroll, mag-apply ng fee waiver bilang *educational institution / government entity*: https://developer.apple.com/support/membership-fee-waiver/
   Kapag hindi naaprubahan, $99 bawat taon ang bayad.

## 2. Gumawa ng app sa App Store Connect

1. https://appstoreconnect.apple.com, tapos **Apps → +** at **New App**
2. Platform: iOS. Name: `GeoAttend` (o ibang pangalan kung kuha na). Bundle ID: `com.geoattend.pro`. SKU: `geoattend-pro`
3. Sa **App Privacy**, ideklara ang kinokolekta ng app:
   - Precise Location: App Functionality
   - Photos or Videos / Other Data (mukha): App Functionality
   - Name, Email Address: App Functionality
   - Lahat ay "linked to user" at hindi ginagamit sa tracking.

## 3. I-build at i-upload (mula sa Windows)

Sa folder na `mobile`:

```
npm install -g eas-cli
eas login
eas build -p ios --profile production
```

Sa unang build, magtatanong ang EAS kung gagamitin ang Apple account mo. Sumagot ng **Yes** at mag-login. Ang EAS na ang gagawa ng certificate, provisioning profile at **push notification key (APNs)**.

Pagkatapos ng build, i-upload ito sa App Store Connect:

```
eas submit -p ios --latest
```

Itatanong nito ang app. Piliin ang ginawa sa Step 2.

## 4. TestFlight (habang nagte-testing)

1. Sa App Store Connect, buksan ang **TestFlight**, at hintaying matapos ang "Processing" (mga 10–30 minuto).
2. **Internal Testing:** hanggang 100 tao na naka-add sa App Store Connect team. Agad itong magagamit.
3. **External Testing:** hanggang 10,000 tao. Gumawa ng group at i-on ang **Public Link**. Dadaan muna ito sa maikling Beta Review (mga 1 araw).
4. Ipapadala ang link sa mga empleyado. I-install muna nila ang **TestFlight** app mula sa App Store, tapos buksan ang link.

Tandaan: nag-e-expire ang bawat TestFlight build pagkalipas ng **90 araw**. Mag-upload ng bagong build bago iyon.

## 5. Unlisted App Store (para sa lahat ng empleyado)

Kapag stable na ang app:

1. Sa App Store Connect, buksan ang **Distribution**, punan ang screenshots at description, at piliin ang build.
2. I-submit ang **Unlisted App Distribution** request: https://developer.apple.com/support/unlisted-app-distribution/
3. **Submit for Review.**
4. Kapag naaprubahan, may link ka na para sa mga empleyado. Hindi lumalabas ang app sa search, normal ang pag-install galing sa App Store, hindi ito nag-e-expire, at may auto-update.

## 6. Notes para sa App Review

Ilagay ito sa **App Review Information → Notes**, kasama ang demo account:

> GeoAttend is the internal attendance app of Camarines Sur Polytechnic Colleges, used only by its employees.
> **Background location ("Always")** is used only while the employee is timed in to an event: it keeps attendance running and times them out automatically when they leave the event's geofence. Tracking stops when they time out.
> **Camera / microphone** are used for a short face-verification video (blink, nod, turn head) at registration, to confirm the employee is a live person.
> Demo account: (ilagay ang email at password, at kung aling event ang bukas)

## Mga susunod na update

```
eas build -p ios --profile production
eas submit -p ios --latest
```

Awtomatikong tumataas ang build number dahil sa `autoIncrement`. Kapag JavaScript lang ang binago, puwede ring `eas update` para hindi na dumaan sa review. Kailangan muna itong i-setup.
