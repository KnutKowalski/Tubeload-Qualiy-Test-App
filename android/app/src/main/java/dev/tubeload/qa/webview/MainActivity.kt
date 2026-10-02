package dev.tubeload.qa.webview

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
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
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var urlInput: EditText
    private lateinit var qualitySpinner: Spinner
    private lateinit var humanCheck: CheckBox
    private lateinit var repeatCheck: CheckBox

    private var pendingConfig: String? = null

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

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)

                val cfg = pendingConfig ?: return
                pendingConfig = null

                web.evaluateJavascript("window.startTest($cfg)", null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                val text = "${consoleMessage.message()} -- Line ${consoleMessage.lineNumber()}"
                runOnUiThread { status.text = text }
                return true
            }
        }

        web.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun log(payload: String) {
                    runOnUiThread {
                        status.text = payload
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

    private fun startTest() {
        val url = urlInput.text.toString().trim()

        if (url.isEmpty()) {
            status.text = "Bitte URL eingeben."
            return
        }

        val cfg = JSONObject()
            .put("url", url)
            .put("quality", qualitySpinner.selectedItem.toString())
            .put("humanize", humanCheck.isChecked)
            .put("repeat", repeatCheck.isChecked)
            .put("mute", true)

        pendingConfig = cfg.toString()
        web.loadUrl("file:///android_asset/player.html")
    }
}
