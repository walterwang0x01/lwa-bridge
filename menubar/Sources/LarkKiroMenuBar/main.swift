// Lark-Kiro-Bridge 菜单栏小工具
//
// 极简 A 方案：Mac 顶部菜单栏图标，点开菜单可以：
//   - 启动 / 停止 bridge 守护进程（调用 CLI 的 `service start`/`service stop`，
//     即 launchd 管理，跟手动敲命令效果一致，只是不用开终端）
//   - 打开 Dashboard 网页（默认 http://127.0.0.1:5180）
//   - 查看运行状态（轮询 dashboard 的 /api/overview，能连上就是"运行中"）
//
// 不是完整桌面 App：没有 Dock 图标、没有独立窗口，只是给已有的 CLI + Dashboard
// 加一个"不用开终端"的入口。跟 OpenHarness 的 ohmo（纯后台网关，无桌面 GUI）
// 属于同一档投入量级，比 Tauri/Electron 套壳窗口轻得多。
//
// 依赖：系统自带 AppKit，不引入任何第三方包。
// 构建：swift build -c release（产物在 .build/release/LarkKiroMenuBar）
import AppKit
import Foundation

/// 找 lwa / lwa-bridge 可执行文件：优先 PATH，其次几个常见的全局安装位置。
func resolveBridgeBin() -> String? {
    let names = ["lwa", "lwa-bridge", "lark-kiro-bridge"]
    let prefixes = [
        "/usr/local/bin",
        "\(NSHomeDirectory())/.npm-global/bin",
        "/opt/homebrew/bin",
    ]
    for prefix in prefixes {
        for name in names {
            let candidate = "\(prefix)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
    }
    // PATH 里找
    if let path = ProcessInfo.processInfo.environment["PATH"] {
        for dir in path.split(separator: ":") {
            for name in names {
                let candidate = "\(dir)/\(name)"
                if FileManager.default.isExecutableFile(atPath: candidate) {
                    return candidate
                }
            }
        }
    }
    return nil
}

/// 跑一个 CLI 子命令（同步等待完成），返回是否成功。
func runBridgeCommand(_ args: [String]) -> Bool {
    guard let bin = resolveBridgeBin() else { return false }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: bin)
    task.arguments = args
    do {
        try task.run()
        task.waitUntilExit()
        return task.terminationStatus == 0
    } catch {
        return false
    }
}

/// Dashboard 端口：读 ~/.lwa/config.json（回退 ~/.lark-kiro-bridge/config.json）的 dashboard.port，默认 5180。
func dashboardPort() -> Int {
    let home = NSHomeDirectory()
    let candidates = [
        "\(home)/.lwa/config.json",
        "\(home)/.lark-kiro-bridge/config.json",
    ]
    for configPath in candidates {
        guard let data = FileManager.default.contents(atPath: configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dashboard = json["dashboard"] as? [String: Any],
              let port = dashboard["port"] as? Int
        else { continue }
        return port
    }
    return 5180
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var pollTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusItem.system_statusBar_item()
        statusItem = item
        item.button?.title = "🌉"
        item.button?.toolTip = "LWA"

        let menu = NSMenu()

        let status = NSMenuItem(title: "状态：检查中…", action: nil, keyEquivalent: "")
        status.isEnabled = false
        statusMenuItem = status
        menu.addItem(status)
        menu.addItem(.separator())

        menu.addItem(
            NSMenuItem(
                title: "启动 Bridge", action: #selector(startBridge), keyEquivalent: "")
        )
        menu.addItem(
            NSMenuItem(title: "停止 Bridge", action: #selector(stopBridge), keyEquivalent: "")
        )
        menu.addItem(.separator())
        menu.addItem(
            NSMenuItem(
                title: "打开 Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        )
        menu.addItem(.separator())
        menu.addItem(
            NSMenuItem(title: "退出菜单栏工具", action: #selector(quit), keyEquivalent: "q")
        )

        for menuItem in menu.items {
            menuItem.target = self
        }
        item.menu = menu

        refreshStatus()
        pollTimer = Timer.scheduledTimer(
            timeInterval: 10, target: self, selector: #selector(refreshStatus),
            userInfo: nil, repeats: true
        )
    }

    @objc func startBridge() {
        DispatchQueue.global(qos: .userInitiated).async {
            _ = runBridgeCommand(["start"])
            DispatchQueue.main.async { self.refreshStatus() }
        }
    }

    @objc func stopBridge() {
        DispatchQueue.global(qos: .userInitiated).async {
            _ = runBridgeCommand(["stop"])
            DispatchQueue.main.async { self.refreshStatus() }
        }
    }

    @objc func openDashboard() {
        let port = dashboardPort()
        if let url = URL(string: "http://127.0.0.1:\(port)") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }

    /// 探测 dashboard 是否可连（能连上代表 bridge 在跑），更新菜单里的状态文案。
    @objc func refreshStatus() {
        let port = dashboardPort()
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/overview") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            let running = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self.statusMenuItem?.title = running ? "状态：🟢 运行中" : "状态：⚪ 未运行"
            }
        }
        task.resume()
    }
}

extension NSStatusItem {
    /// 小工具方法：从系统状态栏拿一个可变长度的 item。
    static func system_statusBar_item() -> NSStatusItem {
        NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不在 Dock 显示图标，纯菜单栏
let delegate = AppDelegate()
app.delegate = delegate
app.run()
