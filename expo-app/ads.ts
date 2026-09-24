// AdMob configuration — the ONLY place ad IDs live on the JS side.
//
// App ID (manifest) : ca-app-pub-5189960264785396~3347386431
//   lives in expo-app/android/app/src/main/AndroidManifest.xml
//   (com.google.android.gms.ads.APPLICATION_ID meta-data) and in
//   expo-app/app.json under react-native-google-mobile-ads.
export const REWARDED_AD_UNIT_ID =
  'ca-app-pub-5189960264785396/7699769490'; // AniNinja watch refill (rewarded)

// Google's public test rewarded unit — always fills, pays nothing. Tried as a
// fallback when the production unit can't load (brand-new unit / app not yet
// reviewed by AdMob), so the refill flow keeps working while fill is flaky.
export const TEST_REWARDED_AD_UNIT_ID = 'ca-app-pub-3940256099942544/5224354917';