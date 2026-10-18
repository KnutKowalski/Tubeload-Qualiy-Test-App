package dev.tubeload.qa.webview

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** Host, unter dem die lokale player.html ausgeliefert wird (https statt file://). */
private const val ASSET_HOST = "appassets.androidplatform.net"

/** Name des JS-Objekts, über das player.html Statusmeldungen an die App schickt. */
private const val BRIDGE_NAME = "TubeloadBridge"

/** Nur diese Hosts dürfen getestet werden. */
private val ALLOWED_HOSTS = setOf(
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be"
)

/** Begrenzungen: ein Test ist eine zeitlich und in Wiederholungen beschränkte Messung. */
private const val DEFAULT_MINUTES = 30
private const val MAX_MINUTES = 240
private const val MAX_LOOPS = 3

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var urlInput: EditText
    private lateinit var minutesInput: EditText
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
        minutesInput = findViewById(R.id.minutes)
        repeatCheck = findViewById(R.id.repeat)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false

            // Keine Mischinhalte, kein Zugriff auf lokale Dateien/Content-Provider.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
        }

        // Cookies aktivieren, damit die vorab gesetzten Consent-Cookies
        // (siehe primeConsentCookies) an den YouTube-Embed gesendet werden.
        // Der Embed laeuft in einem Drittanbieter-Frame und braucht sie.
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

            // Der Hauptframe darf die lokale Seite nie verlassen (z. B. durch Links im
            // Embed). Navigationen in Unterframes (der YouTube-Player) bleiben erlaubt.
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                if (request == null) return true
                if (!request.isForMainFrame) return false

                val url = request.url
                return !(url.scheme == "https" && url.host == ASSET_HOST)
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

            // Stirbt der Renderer-Prozess (z. B. Speichermangel), wuerde die App sonst
            // abstuerzen. Die WebView ist danach unbrauchbar: aufraeumen und beenden.
            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity,
                        "Der WebView-Prozess wurde beendet. Bitte die App neu starten.",
                        Toast.LENGTH_LONG
                    ).show()
                    finish()
                }

                return true
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

        installBridge()

        findViewById<Button>(R.id.start).setOnClickListener {
            startTest()
        }

        findViewById<Button>(R.id.stop).setOnClickListener {
            web.evaluateJavascript("window.stopPlayback && window.stopPlayback()", null)
        }
    }

    /**
     * Statusmeldungen der player.html. Anders als addJavascriptInterface ist dieser
     * Kanal an einen Ursprung gebunden: nur die lokale Seite (und nicht der
     * YouTube-Frame oder eine fremde Seite) kann der App Nachrichten schicken.
     */
    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            status.text = "Diese WebView-Version wird nicht unterstuetzt. Bitte 'Android System WebView' aktualisieren."
            return
        }

        WebViewCompat.addWebMessageListener(
            web,
            BRIDGE_NAME,
            setOf("https://$ASSET_HOST"),
            WebViewCompat.WebMessageListener { _, message, _, isMainFrame, _ ->
                val payload = message.data

                if (isMainFrame && payload != null) {
                    runOnUiThread {
                        status.text = formatStatus(payload)
                    }
                }
            }
        )
    }

    /**
     * Setzt die YouTube-Consent-Cookies (SOCS/CONSENT) vorab im WebView, damit der
     * Embed keine Consent-Wand zeigt, die die automatische Wiedergabe blockieren
     * wuerde. Die Werte sind vorgefertigt und koennen von YouTube jederzeit
     * ungueltig werden – dann erscheint der Dialog wieder.
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
                "playing" -> "Laeuft  %.0f s / %.0f s  gepuffert %.0f%%  Durchlauf %d".format(
                    o.optDouble("currentTime", 0.0),
                    o.optDouble("duration", 0.0),
                    o.optDouble("loadedFraction", 0.0) * 100,
                    o.optInt("loop", 1)
                )
                "paused" -> "Pausiert  %.0f s".format(o.optDouble("currentTime", 0.0))
                "buffering" -> "Puffert..."
                "ended" -> "Beendet."
                "completed" -> "Fertig nach %d Durchlauf/Durchlaeufen.".format(o.optInt("loops", 1))
                "max_runtime" -> "Maximale Laufzeit erreicht – Test beendet."
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

    private fun isAllowedUrl(raw: String): Boolean {
        val uri = Uri.parse(raw)

        if (uri.scheme != "https") return false
        if (uri.userInfo != null) return false

        val host = uri.host?.lowercase() ?: return false

        return host in ALLOWED_HOSTS
    }

    private fun startTest() {
        val url = urlInput.text.toString().trim()

        if (url.isEmpty()) {
            status.text = "Bitte URL eingeben."
            return
        }

        if (!isAllowedUrl(url)) {
            status.text = "Nur https-URLs von youtube.com, m./music.youtube.com und youtu.be sind erlaubt."
            return
        }

        val minutes = minutesInput.text.toString().trim().toIntOrNull()
            ?.coerceIn(1, MAX_MINUTES)
            ?: DEFAULT_MINUTES

        // Consent-Status setzen, BEVOR der Embed geladen wird,
        // damit YouTube gar keine Consent-Wand zeigt.
        primeConsentCookies()

        val cfg = JSONObject()
            .put("url", url)
            .put("repeat", repeatCheck.isChecked)
            .put("maxLoops", MAX_LOOPS)
            .put("maxRuntimeSec", minutes * 60)
            .put("mute", true)
            .toString()

        pendingConfig = cfg
        web.loadUrl("https://$ASSET_HOST/assets/player.html")
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)

        // WebView sauber abbauen (sonst bleiben Timer/Player im Hintergrund aktiv).
        web.evaluateJavascript("window.stopPlayback && window.stopPlayback()", null)
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()

        super.onDestroy()
    }
}
