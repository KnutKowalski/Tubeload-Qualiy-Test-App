package dev.tubeload.qa.webview

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var urlInput: EditText
    private lateinit var qualitySpinner: Spinner
    private lateinit var humanCheck: CheckBox
    private lateinit var repeatCheck: CheckBox

    private var pendingConfig: String? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Liefert die player.html ueber einen echten HTTPS-Ursprung
     * (https://appassets.androidplatform.net/assets/...).
     * Die YouTube-Iframe-API ist ueber file://-Urspruenge unzuverlaessig,
     * weil die PostMessage-Kommunikation an den Seitenursprung gebunden ist.
     */
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        status = findViewById(R.id.status)
        urlInput = findViewById(R.id.url)
        qualitySpinner = findViewById(R.id.quality)
        humanCheck = findViewById(R.id.human)
        repeatCheck = findViewById(R.id.repeat)

        val qualities = listOf("auto", "480p", "720p", "1080p", "1440p", "2160p")
        qualitySpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            qualities
        )

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        // Cookies aktivieren, damit die vorab gesetzten Consent-Cookies
        // (siehe primeConsentCookies) an den YouTube-Embed gesendet werden.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return null
                return assetLoader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                return false
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)

                if (request?.isForMainFrame == true) {
                    runOnUiThread {
                        status.text = "Ladefehler: ${error?.description ?: "unbekannt"}"
                    }
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)

                val cfg = pendingConfig ?: return
                pendingConfig = null

                injectConfig(cfg)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                // Nur echte JS-Fehler im Status anzeigen; normale
                // Konsol-Meldungen ueberschreiben den Status nicht mehr.
                if (consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    runOnUiThread {
                        status.text = "JS-Fehler: ${consoleMessage.message()} (Zeile ${consoleMessage.lineNumber()})"
                    }
                }

                return true
            }
        }

        web.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun log(payload: String) {
                    runOnUiThread {
                        status.text = formatStatus(payload)
                    }
                }
            },
            "Android"
        )

        findViewById<Button>(R.id.start).setOnClickListener {
            startTest()
        }

        findViewById<Button>(R.id.stop).setOnClickListener {
            web.evaluateJavascript("window.stopPlayback && window.stopPlayback()", null)
        }
    }

    /**
     * Setzt die YouTube-Consent-Cookies (SOCS/CONSENT) vorab im WebView —
     * so wie es YouTube nach einem Klick auf "Alle akzeptieren" selbst
     * tun wuerde. Damit zeigt der YouTube-Embed keine Consent-/Datenschutz-
     * Wand mehr, die die automatische Wiedergabe blockieren wuerde.
     */
    private fun primeConsentCookies() {
        val cm = CookieManager.getInstance()

        val socs = "SOCS=CAE; Path=/; Secure; Domain=.youtube.com"
        val consent =
            "CONSENT=YES+cb.20210328-17-p0.en+FX+419; Path=/; Secure; Domain=.youtube.com"

        cm.setCookie("https://www.youtube.com", socs)
        cm.setCookie("https://www.youtube.com", consent)
        cm.setCookie("https://consent.youtube.com", socs)
        cm.setCookie("https://consent.youtube.com", consent)

        cm.flush()
    }

    /**
     * Konfiguration in die Seite injizieren. Direkt nach onPageFinished kann
     * window.startTest noch nicht definiert sein, daher bis zu 5 s wiederholen.
     */
    private fun injectConfig(cfg: String, attempt: Int = 0) {
        web.evaluateJavascript(
            "(function(){ if (typeof window.startTest !== 'function') return false; window.startTest(${cfg}); return true; })()"
        ) { result ->
            if (result == "true") {
                return@evaluateJavascript
            }

            if (attempt < 20) {
                mainHandler.postDelayed({ injectConfig(cfg, attempt + 1) }, 250)
            } else {
                status.text = "Start fehlgeschlagen: player.html nicht initialisiert."
            }
        }
    }

    /** JSON-Logzeile aus player.html in einen lesbaren Status uebersetzen. */
    private fun formatStatus(payload: String): String {
        return try {
            val o = JSONObject(payload)

            when (o.optString("state", "")) {
                "ready" -> "Player bereit."
                "playing" -> "Laeuft  %.0f s / %.0f s  Qualitaet %s  gepuffert %.0f%%".format(
                    o.optDouble("currentTime", 0.0),
                    o.optDouble("duration", 0.0),
                    o.optString("quality", "?"),
                    o.optDouble("loadedFraction", 0.0) * 100
                )
                "paused" -> "Pausiert  %.0f s".format(o.optDouble("currentTime", 0.0))
                "buffering" -> "Puffert..."
                "ended" -> "Beendet."
                "stopped" -> "Gestoppt."
                "quality_change" -> "Qualitaet: %s".format(o.optString("quality", "?"))
                "not_playing" ->
                    "Keine Wiedergabe: %s".format(o.optString("detail", "unbekannt"))
                "error" -> "Fehler: %s (%s)".format(
                    o.optString("error", "?"),
                    o.optString("detail", "")
                )
                else -> "Status: %s".format(o.optString("state", payload))
            }
        } catch (e: Exception) {
            payload
        }
    }

    private fun startTest() {
        val url = urlInput.text.toString().trim()

        if (url.isEmpty()) {
            status.text = "Bitte URL eingeben."
            return
        }

        // Consent-Status setzen, BEVOR der Embed geladen wird,
        // damit YouTube gar keine Consent-Wand zeigt.
        primeConsentCookies()

        val cfg = JSONObject()
            .put("url", url)
            .put("quality", qualitySpinner.selectedItem.toString())
            .put("humanize", humanCheck.isChecked)
            .put("repeat", repeatCheck.isChecked)
            .put("mute", true)
            .toString()

        pendingConfig = cfg
        web.loadUrl("https://appassets.androidplatform.net/assets/player.html")
    }
}
