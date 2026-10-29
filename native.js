/*
 * 앱(안드로이드·iOS)에서만 켜지는 네이티브 연결 층.
 * 웹 브라우저에서 열면 아무 일도 하지 않고, 앱 코드는 그대로 localStorage를 씁니다.
 *
 * 앱 안에서는:
 *  - 카운트·프로젝트·설정 → 기기 저장소(Preferences)에 함께 저장하고, 앱을 열 때 되살립니다.
 *  - 배경·작품 사진 → 앱 전용 폴더(Filesystem, DATA)에 파일로 저장합니다.
 *    브라우저 저장 공간 한도(약 5MB)를 받지 않아서 사진을 많이 넣어도 괜찮아요.
 *  - 진동(Haptics), 화면 꺼짐 방지(KeepAwake), 백업 파일 공유(Share)를 네이티브로 처리합니다.
 */
(function () {
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());

  function call(plugin, method, options) {
    if (!isNative || typeof cap.nativePromise !== "function") return Promise.reject(new Error("not native"));
    return cap.nativePromise(plugin, method, options || {});
  }

  var NativeApp = {
    isNative: isNative,
    call: call,
    haptic: function (kind) {
      if (!isNative) return false;
      var p;
      if (kind === "success") p = call("Haptics", "notification", { type: "SUCCESS" });
      else if (kind === "warning") p = call("Haptics", "notification", { type: "WARNING" });
      else if (kind === "medium") p = call("Haptics", "impact", { style: "MEDIUM" });
      else p = call("Haptics", "impact", { style: "LIGHT" });
      p.catch(function () {});
      return true;
    },
    keepAwake: function () {
      if (!isNative) return false;
      call("KeepAwake", "keepAwake").catch(function () {});
      return true;
    },
    // 안드로이드 뒤로가기 버튼. 등록하면 기본 동작(앱 종료) 대신 handler가 불려요.
    onBack: function (handler) {
      if (!isNative || typeof cap.addListener !== "function") return;
      try { cap.addListener("App", "backButton", handler); } catch (e) {}
    },
    minimize: function () {
      call("App", "minimizeApp").catch(function () { call("App", "exitApp").catch(function () {}); });
    },
    // 백업 파일을 앱 캐시에 쓰고 공유 창을 띄웁니다 ("파일에 저장", 드라이브, 메일 등).
    shareTextFile: function (name, text) {
      return call("Filesystem", "writeFile", { path: name, data: text, directory: "CACHE", encoding: "utf8" })
        .then(function (res) { return call("Share", "share", { title: name, files: [res.uri], dialogTitle: "백업 파일 저장" }); });
    }
  };
  // ---------- 광고 (AdMob 배너) ----------
  // 숫자 세는 화면에는 절대 띄우지 않고, 설정창이 열려 있을 때만 화면 맨 아래에 작은 배너를 보여 줘요.
  // 단단 실제 배너 광고 단위 ID ("설정 배너")
  // (앱 ID는 android/app/src/main/res/values/strings.xml 의 admob_app_id)
  var ADMOB_BANNER_ID = "ca-app-pub-2486517051650098/7465859724";
  var ADMOB_TEST = ADMOB_BANNER_ID.indexOf("ca-app-pub-3940256099942544/") === 0;
  // 광고가 어디까지 진행됐는지 기록 (설정 맨 아래 버전 글자를 5번 누르면 보여요)
  var adLog = [];
  function note(t) { adLog.push(new Date().toTimeString().slice(0, 8) + " " + t); if (adLog.length > 12) adLog.shift(); }
  function errText(e) { return String((e && (e.code || "")) + " " + ((e && e.message) || e || "")).trim(); }
  var ads = { ready: false, starting: null, created: false, visible: false, want: false, privacyRequired: false, onHeight: null };
  function adHeight(h) { if (typeof ads.onHeight === "function") ads.onHeight(h > 0 ? h : 0); }
  function applyAd() {
    if (!ads.ready) return;
    if (ads.want && !ads.visible) {
      ads.visible = true;
      note(ads.created ? "배너 다시 보이기" : "배너 요청");
      var p = ads.created ? call("AdMob", "resumeBanner")
        : call("AdMob", "showBanner", { adId: ADMOB_BANNER_ID, adSize: "ADAPTIVE_BANNER", position: "BOTTOM_CENTER", margin: 0, isTesting: ADMOB_TEST });
      ads.created = true;
      p.catch(function (e) { note("배너 실패: " + errText(e)); ads.visible = false; ads.created = false; adHeight(0); });
    } else if (!ads.want && ads.visible) {
      ads.visible = false;
      call("AdMob", "hideBanner").catch(function () {});
      adHeight(0);
    }
  }
  NativeApp.ads = {
    // 앱을 켤 때 한 번: 유럽 등 동의가 필요한 지역이면 구글 동의 창을 띄우고, 광고 SDK를 준비해요.
    start: function () {
      if (!isNative) return Promise.resolve(false);
      if (ads.starting) return ads.starting;
      try {
        cap.addListener("AdMob", "bannerAdSizeChanged", function (s) { if (ads.visible) adHeight(s && s.height); });
        cap.addListener("AdMob", "bannerAdLoaded", function () { note("광고 받음"); });
        cap.addListener("AdMob", "bannerAdFailedToLoad", function (e) { note("광고 못 받음: " + errText(e)); adHeight(0); });
      } catch (e) { note("리스너 실패: " + errText(e)); }
      note("동의 확인 시작");
      // 동의 메시지 설정이 없거나 확인에 실패해도 광고는 시작해요 (한국 사용자는 동의가 필요 없음)
      ads.starting = call("AdMob", "requestConsentInfo", {})
        .catch(function (e) { note("동의 확인 실패(계속 진행): " + errText(e)); return null; })
        .then(function (info) {
          if (!info) return null;
          note("동의 상태: " + (info && info.status) + ", 요청 가능: " + (info && info.canRequestAds));
          if (info && info.isConsentFormAvailable && info.status === "REQUIRED") return call("AdMob", "showConsentForm");
          return info;
        })
        .then(function (info) {
          ads.privacyRequired = !!(info && info.privacyOptionsRequirementStatus === "REQUIRED");
          if (info && info.canRequestAds === false) { note("동의 없음 → 광고 안 함"); return false; }
          note("SDK 준비 시작");
          return call("AdMob", "initialize", {
            tagForChildDirectedTreatment: false, tagForUnderAgeOfConsent: false, maxAdContentRating: "General"
          }).then(function () { note("SDK 준비 완료"); ads.ready = true; applyAd(); return true; });
        })
        .catch(function (e) { note("시작 실패: " + errText(e)); return false; });
      return ads.starting;
    },
    setVisible: function (want) { ads.want = !!want; applyAd(); },
    // 광고 제거를 산 뒤: 배너를 완전히 없애요.
    remove: function () {
      ads.want = false; ads.visible = false; adHeight(0);
      if (ads.created) { ads.created = false; call("AdMob", "removeBanner").catch(function () {}); }
    },
    onHeight: function (fn) { ads.onHeight = fn; },
    privacyRequired: function () { return ads.privacyRequired; },
    log: function () { return adLog.slice(); },
    note: note,
    showPrivacyOptions: function () { return call("AdMob", "showPrivacyOptionsForm"); }
  };

  // ---------- 앱 내 결제 (광고 제거 + 완성 목록 무제한, 한 번 결제) ----------
  // Play Console → 수익 창출 → 인앱 상품에서 같은 ID로 상품을 만들어야 해요.
  var PRODUCT_ID = "dandan_premium";
  function isOurs(t) { return t && t.productIdentifier === PRODUCT_ID; }
  NativeApp.store = {
    productId: PRODUCT_ID,
    available: isNative,
    // 결제한 적이 있는지 Google Play에 물어봐요. 답: true / false / null(확인 못 함, 예: 오프라인)
    check: function () {
      if (!isNative) return Promise.resolve(null);
      return call("NativePurchases", "getPurchases", { productType: "inapp" })
        .then(function (r) {
          var list = (r && r.purchases) || [];
          return list.some(function (t) { return isOurs(t) && String(t.purchaseState) === "1"; });
        })
        .catch(function () { return null; });
    },
    // 스토어에 표시된 가격 문자열 (예: "₩1,000"). 못 가져오면 null
    price: function () {
      if (!isNative) return Promise.resolve(null);
      return call("NativePurchases", "getProduct", { productIdentifier: PRODUCT_ID, productType: "inapp" })
        .then(function (r) { return (r && r.product && r.product.priceString) || null; })
        .catch(function () { return null; });
    },
    // 결제 창을 띄워요. 답: "ok" / "pending"(결제 대기 중) / "cancel" / "error"
    buy: function () {
      if (!isNative) return Promise.resolve("error");
      return call("NativePurchases", "purchaseProduct", { productIdentifier: PRODUCT_ID, productType: "inapp", isConsumable: false, autoAcknowledgePurchases: true })
        .then(function (t) {
          if (String(t && t.purchaseState) === "0") return "pending";
          return "ok";
        })
        .catch(function (e) {
          var m = (String((e && e.code) || "") + " " + String((e && e.message) || "")).toLowerCase();
          if (m.indexOf("cancel") >= 0) return "cancel";
          if (m.indexOf("pending") >= 0) return "pending";
          if (m.indexOf("already") >= 0 || m.indexOf("owned") >= 0) return "ok";
          return "error";
        });
    }
  };

  window.NativeApp = NativeApp;

  if (!isNative) { window.__appReady = Promise.resolve(); return; }

  // ---------- storage bridge ----------
  var PHOTO_PREFIX = "glass-knit-counter-bg-v1:";
  var PHOTO_DIR = "photos";
  var photos = Object.create(null);
  var proto = Storage.prototype;
  var origGet = proto.getItem, origSet = proto.setItem, origRemove = proto.removeItem;

  function isPhotoKey(k) { return typeof k === "string" && k.indexOf(PHOTO_PREFIX) === 0; }
  function photoPath(k) { return PHOTO_DIR + "/" + encodeURIComponent(k.slice(PHOTO_PREFIX.length)) + ".txt"; }
  function writePhoto(k, v) {
    return call("Filesystem", "writeFile", { path: photoPath(k), data: v, directory: "DATA", encoding: "utf8", recursive: true }).catch(function () {});
  }

  proto.getItem = function (k) {
    if (this === window.localStorage && isPhotoKey(k)) return k in photos ? photos[k] : null;
    return origGet.call(this, k);
  };
  proto.setItem = function (k, v) {
    if (this === window.localStorage) {
      v = String(v);
      if (isPhotoKey(k)) { photos[k] = v; writePhoto(k, v); return; }
      origSet.call(this, k, v);
      call("Preferences", "set", { key: k, value: v }).catch(function () {});
      return;
    }
    return origSet.call(this, k, v);
  };
  proto.removeItem = function (k) {
    if (this === window.localStorage) {
      if (isPhotoKey(k)) {
        delete photos[k];
        call("Filesystem", "deleteFile", { path: photoPath(k), directory: "DATA" }).catch(function () {});
        return;
      }
      origRemove.call(this, k);
      call("Preferences", "remove", { key: k }).catch(function () {});
      return;
    }
    return origRemove.call(this, k);
  };

  function restorePreferences() {
    return call("Preferences", "keys").then(function (res) {
      var keys = (res && res.keys) || [];
      return Promise.all(keys.map(function (k) {
        if (origGet.call(localStorage, k) !== null) return null;
        return call("Preferences", "get", { key: k }).then(function (r) {
          if (r && typeof r.value === "string") origSet.call(localStorage, k, r.value);
        }).catch(function () {});
      }));
    }).then(function () {
      // 이미 localStorage에만 있던 값은 기기 저장소로도 한 번 옮겨 둡니다.
      var jobs = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var v = origGet.call(localStorage, k);
        if (isPhotoKey(k)) { photos[k] = v; jobs.push(writePhoto(k, v)); continue; }
        jobs.push(call("Preferences", "set", { key: k, value: v }).catch(function () {}));
      }
      return Promise.all(jobs);
    }).then(function () {
      // 사진은 파일로 옮겼으니 localStorage에서는 비웁니다.
      Object.keys(photos).forEach(function (k) { origRemove.call(localStorage, k); });
    }).catch(function () {});
  }

  function restorePhotos() {
    return call("Filesystem", "readdir", { path: PHOTO_DIR, directory: "DATA" }).then(function (res) {
      var files = (res && res.files) || [];
      return Promise.all(files.map(function (f) {
        var name = typeof f === "string" ? f : f.name;
        if (!name || !/\.txt$/.test(name)) return null;
        var key = PHOTO_PREFIX + decodeURIComponent(name.replace(/\.txt$/, ""));
        if (key in photos) return null;
        return call("Filesystem", "readFile", { path: PHOTO_DIR + "/" + name, directory: "DATA", encoding: "utf8" })
          .then(function (r) { if (r && typeof r.data === "string") photos[key] = r.data; })
          .catch(function () {});
      }));
    }).catch(function () { /* 사진 폴더가 아직 없으면 그냥 넘어갑니다 */ });
  }

  // 상태바 아이콘을 밝게(어두운 배경용) 맞춥니다.
  call("SystemBars", "setStyle", { style: "DARK" }).catch(function () {});

  // 앱 화면은 저장된 데이터를 다 읽은 뒤에 시작합니다. 너무 오래 걸리면 4초 뒤 그냥 시작해요.
  window.__appReady = Promise.race([
    restorePreferences().then(restorePhotos),
    new Promise(function (resolve) { setTimeout(resolve, 4000); })
  ]).then(function () {
    call("SplashScreen", "hide").catch(function () {});
  });
})();
