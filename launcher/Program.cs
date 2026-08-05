using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.WinForms;

namespace ClaudeWorkbenchLauncher
{
    internal static class Program
    {
        private const int DefaultPort = 3137;
        private const string StartupRunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string StartupValueName = "ClaudeWorkbench";
        private static string AppUrl = "http://127.0.0.1:3137";
        private static Form MainForm;
        private static NotifyIcon TrayIcon;
        private static ContextMenuStrip TrayMenu;
        private static ServerLease ActiveServer;
        private static bool ExitRequested;
        private static string SessionToken = "";

        [STAThread]
        private static int Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveAssembly;

            bool selfTest = args != null && Array.IndexOf(args, "--self-test") >= 0;
            bool cliMode = args != null && Array.IndexOf(args, "--cli") >= 0;
            bool chromeMode = args != null && Array.IndexOf(args, "--chrome") >= 0;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string executablePath = Environment.ProcessPath ?? Application.ExecutablePath;
            string executableDirectory = Path.GetDirectoryName(executablePath) ?? AppDomain.CurrentDomain.BaseDirectory;
            string root = ResolveAppRoot(executableDirectory);
            string serverPath = Path.Combine(root, "server.js");
            string cliPath = Path.Combine(root, "code-cli.js");
            if (!File.Exists(serverPath) || !File.Exists(cliPath))
            {
                return Fail(selfTest, "未找到应用文件。请把 ClaudeWorkbench 文件夹保留在 ClaudeWorkbench.exe 同级目录。");
            }

            string node = ResolveNode(root);
            SessionToken = ResolveSessionToken();
            if (string.IsNullOrWhiteSpace(SessionToken))
            {
                SessionToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                Environment.SetEnvironmentVariable("WORKBENCH_SESSION_TOKEN", SessionToken, EnvironmentVariableTarget.Process);
            }
            try
            {
                if (selfTest) return RunSelfTest(node, root);
                if (cliMode)
                {
                    StartTerminal(node, root);
                    return 0;
                }
                if (chromeMode) return StartChromeApp(node, root);
                return StartDesktopApp(node, root);
            }
            catch (Exception ex)
            {
                return Fail(selfTest, "启动 NPA 本地智能工作台失败: " + ex.Message);
            }
        }

        private static string ResolveAppRoot(string exeDir)
        {
            string direct = Path.Combine(exeDir, "server.js");
            if (File.Exists(direct)) return exeDir;
            string child = Path.Combine(exeDir, "ClaudeWorkbench");
            if (File.Exists(Path.Combine(child, "server.js"))) return child;
            return exeDir;
        }

        private static Assembly ResolveAssembly(object sender, ResolveEventArgs args)
        {
            try
            {
                string assemblyName = new AssemblyName(args.Name).Name + ".dll";
                string processPath = Environment.ProcessPath ?? Application.ExecutablePath;
                string exeDir = Path.GetDirectoryName(processPath) ?? AppDomain.CurrentDomain.BaseDirectory;
                string root = ResolveAppRoot(exeDir);
                string[] candidates =
                {
                    Path.Combine(exeDir, assemblyName),
                    Path.Combine(root, assemblyName),
                    Path.Combine(exeDir, "ClaudeWorkbench", assemblyName)
                };
                foreach (string candidate in candidates)
                {
                    if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
                }
            }
            catch
            {
            }
            return null;
        }

        private static int Fail(bool selfTest, string message)
        {
            if (selfTest) Console.Error.WriteLine(message);
            else MessageBox.Show(message, "NPA · 本地智能工作台");
            return 1;
        }

        private static string ResolveNode(string root)
        {
            string bundled = Path.Combine(root, "node.exe");
            if (File.Exists(bundled)) return bundled;
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathValue.Split(Path.PathSeparator))
            {
                try
                {
                    string candidate = Path.Combine(part.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                }
            }
            return "node";
        }

        private static string ResolveWorkbenchDataDir()
        {
            string dataDir = Environment.GetEnvironmentVariable("WORKBENCH_DATA_DIR") ?? "";
            if (string.IsNullOrWhiteSpace(dataDir))
            {
                dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWorkbench", "data");
            }
            Directory.CreateDirectory(dataDir);
            return dataDir;
        }

        private static int RunSelfTest(string node, string root)
        {
            string cliOut;
            string cliErr;
            int cliExit = RunProcess(node, "code-cli.js --self-test", root, true, out cliOut, out cliErr);
            if (!string.IsNullOrWhiteSpace(cliOut)) Console.WriteLine(cliOut);
            if (!string.IsNullOrWhiteSpace(cliErr)) Console.Error.WriteLine(cliErr);
            if (cliExit != 0 || !cliOut.Contains("SELF_TEST_OK")) return 1;

            using (ServerLease server = EnsureServer(node, root))
            {
                bool ok = WaitForServer(server.Url, root);
                server.Dispose();
                if (!ok)
                {
                    Console.WriteLine("DESKTOP_SELF_TEST_FAILED");
                    return 1;
                }
            }

            try
            {
                using (WebView2 probe = new WebView2())
                {
                    Console.WriteLine("WEBVIEW2_SELF_TEST_OK");
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("WEBVIEW2_SELF_TEST_FAILED: " + ex.Message);
                return 1;
            }

            Console.WriteLine("DESKTOP_SELF_TEST_OK");
            return 0;
        }

        private static int StartDesktopApp(string node, string root)
        {
            ServerLease server = EnsureServer(node, root);
            ActiveServer = server;
            if (!WaitForServer(server.Url, root))
            {
                server.Dispose();
                ActiveServer = null;
                MessageBox.Show("本地服务没有启动。可以尝试运行 ClaudeWorkbench.exe --cli 进入终端模式。", "NPA · 本地智能工作台");
                return 1;
            }

            Form form = new Form
            {
                Text = "NPA · 本地智能工作台",
                Width = 1440,
                Height = 900,
                StartPosition = FormStartPosition.CenterScreen
            };
            MainForm = form;
            try
            {
                form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
            }
            WebView2 webView = new WebView2 { Dock = DockStyle.Fill };
            form.Controls.Add(webView);
            TrayIcon = CreateTrayIcon(form);
            form.FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (ExitRequested) return;
                // Closing the main window is intentionally non-destructive: the
                // local server and long-running jobs remain alive in the tray.
                e.Cancel = true;
                form.Hide();
                if (TrayIcon != null) TrayIcon.ShowBalloonTip(1200, "NPA · 本地智能工作台", "工作台已最小化到托盘，服务仍在运行。", ToolTipIcon.Info);
            };
            form.FormClosed += delegate
            {
                DisposeTrayIcon();
                server.Dispose();
                ActiveServer = null;
                MainForm = null;
            };
            form.Shown += delegate
            {
                try
                {
                    webView.Source = new Uri(server.Url);
                }
                catch (Exception ex)
                {
                    MessageBox.Show("WebView2 加载失败: " + ex.Message, "NPA · 本地智能工作台");
                }
            };
            form.Resize += delegate
            {
                // Keep minimize-to-tray predictable for keyboard/system minimize
                // actions while allowing the user to restore from the tray menu.
                if (form.WindowState == FormWindowState.Minimized && !ExitRequested)
                {
                    form.Hide();
                }
            };
            Application.Run(form);
            return 0;
        }

        private static NotifyIcon CreateTrayIcon(Form form)
        {
            TrayMenu = new ContextMenuStrip();
            ToolStripMenuItem showItem = new ToolStripMenuItem("显示工作台");
            ToolStripMenuItem pauseAllItem = new ToolStripMenuItem("暂停全部");
            ToolStripMenuItem resumeAllItem = new ToolStripMenuItem("恢复");
            ToolStripMenuItem approvalsItem = new ToolStripMenuItem("待审批");
            ToolStripMenuItem startupItem = new ToolStripMenuItem("开机自启") { CheckOnClick = true };
            ToolStripMenuItem exitItem = new ToolStripMenuItem("彻底退出");

            string startupReadError;
            startupItem.Checked = TryReadStartupRegistration(out startupReadError);

            showItem.Click += delegate { ShowMainWindow(form); };
            pauseAllItem.Click += async delegate
            {
                await RunTrayAction("暂停全部", new[] { "/api/v1/runs/pause-all", "/api/runs/pause-all" });
            };
            resumeAllItem.Click += async delegate
            {
                await RunTrayAction("恢复", new[] { "/api/v1/runs/resume-all", "/api/runs/resume-all" });
            };
            approvalsItem.Click += async delegate { await ShowPendingApprovals(); };
            startupItem.Click += delegate
            {
                bool enabled = startupItem.Checked;
                string error;
                if (!TrySetStartupRegistration(enabled, out error))
                {
                    startupItem.Checked = !enabled;
                    ShowStartupMessage(
                        (enabled ? "无法启用“开机自启”，设置保持关闭。" : "无法关闭“开机自启”，设置保持原状。") +
                        Environment.NewLine + error,
                        MessageBoxIcon.Warning);
                    return;
                }

                ShowStartupSuccess(enabled);
            };
            exitItem.Click += async delegate { await ExitFromTray(form, exitItem); };

            TrayMenu.Items.Add(showItem);
            TrayMenu.Items.Add(new ToolStripSeparator());
            TrayMenu.Items.Add(pauseAllItem);
            TrayMenu.Items.Add(resumeAllItem);
            TrayMenu.Items.Add(approvalsItem);
            TrayMenu.Items.Add(startupItem);
            TrayMenu.Items.Add(new ToolStripSeparator());
            TrayMenu.Items.Add(exitItem);

            Icon icon;
            try
            {
                icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            }
            catch
            {
                icon = SystemIcons.Application;
            }
            NotifyIcon tray = new NotifyIcon
            {
                Text = "NPA · 本地智能工作台",
                Icon = icon,
                ContextMenuStrip = TrayMenu,
                Visible = true
            };
            tray.DoubleClick += delegate { ShowMainWindow(form); };
            if (!string.IsNullOrWhiteSpace(startupReadError))
            {
                ShowStartupMessage("无法读取“开机自启”设置，当前保持关闭。" + Environment.NewLine + startupReadError, MessageBoxIcon.Warning);
            }
            return tray;
        }

        private static bool TryReadStartupRegistration(out string error)
        {
            error = "";
            try
            {
                using (RegistryKey? runKey = Registry.CurrentUser.OpenSubKey(StartupRunKey, writable: false))
                {
                    if (runKey == null) return false;
                    object? value = runKey.GetValue(StartupValueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    return value is string text
                        && string.Equals(text.Trim(), GetStartupCommand(), StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool TrySetStartupRegistration(bool enabled, out string error)
        {
            error = "";
            try
            {
                if (enabled)
                {
                    string command = GetStartupCommand();
                    using (RegistryKey? runKey = Registry.CurrentUser.CreateSubKey(StartupRunKey, writable: true))
                    {
                        if (runKey == null) throw new InvalidOperationException("无法打开当前用户的启动项注册表。");
                        runKey.SetValue(StartupValueName, command, RegistryValueKind.String);
                    }
                }
                else
                {
                    using (RegistryKey? runKey = Registry.CurrentUser.OpenSubKey(StartupRunKey, writable: true))
                    {
                        if (runKey != null) runKey.DeleteValue(StartupValueName, throwOnMissingValue: false);
                    }
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string GetStartupCommand()
        {
            string executablePath = Environment.ProcessPath ?? Application.ExecutablePath;
            if (string.IsNullOrWhiteSpace(executablePath)) throw new InvalidOperationException("未找到当前可执行文件路径。");
            string fullPath = Path.GetFullPath(executablePath);
            return "\"" + fullPath.Replace("\"", "\\\"") + "\"";
        }

        private static void ShowStartupMessage(string message, MessageBoxIcon icon)
        {
            MessageBox.Show(message, "NPA · 本地智能工作台", MessageBoxButtons.OK, icon);
        }

        private static void ShowStartupSuccess(bool enabled)
        {
            if (TrayIcon != null)
            {
                TrayIcon.ShowBalloonTip(1600, "NPA · 本地智能工作台", enabled ? "开机自启已启用。" : "开机自启已关闭。", ToolTipIcon.Info);
            }
        }

        private static void ShowMainWindow(Form form)
        {
            if (form == null || form.IsDisposed) return;
            if (!form.Visible) form.Show();
            if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
            form.Activate();
        }

        private static void DisposeTrayIcon()
        {
            try
            {
                if (TrayIcon != null)
                {
                    TrayIcon.Visible = false;
                    TrayIcon.Dispose();
                }
                if (TrayMenu != null) TrayMenu.Dispose();
            }
            catch
            {
            }
            TrayIcon = null;
            TrayMenu = null;
        }

        private static async Task RunTrayAction(string label, string[] paths)
        {
            try
            {
                await TrayRequestWithFallback(paths, "POST", new { });
                TrayIcon?.ShowBalloonTip(1200, "NPA · 本地智能工作台", label + "请求已提交。", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                TrayIcon?.ShowBalloonTip(1800, "NPA · 本地智能工作台", label + "失败: " + ex.Message, ToolTipIcon.Warning);
            }
        }

        private static async Task ShowPendingApprovals()
        {
            try
            {
                string body = await TrayRequestWithFallback(new[] { "/api/v1/approvals?status=pending", "/api/approvals" }, "GET", null);
                int count = CountPendingApprovals(body);
                string message = count >= 0 ? "当前待审批项: " + count : "待审批列表已刷新。";
                TrayIcon?.ShowBalloonTip(1800, "NPA · 本地智能工作台", message, ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                TrayIcon?.ShowBalloonTip(1800, "NPA · 本地智能工作台", "待审批查询失败: " + ex.Message, ToolTipIcon.Warning);
            }
        }

        private static async Task ExitFromTray(Form form, ToolStripMenuItem exitItem)
        {
            if (ExitRequested) return;
            ExitRequested = true;
            if (exitItem != null) exitItem.Enabled = false;
            // Persist a final checkpoint before pausing workers. Both requests
            // are attempted so a partial API failure does not strand jobs.
            try
            {
                await TrayRequestWithFallback(new[] { "/api/v1/runs/checkpoint-all", "/api/v1/checkpoint-all", "/api/checkpoint" }, "POST", new { });
            }
            catch (Exception ex)
            {
                TrayIcon?.ShowBalloonTip(1800, "NPA · 本地智能工作台", "检查点保存失败: " + ex.Message, ToolTipIcon.Warning);
            }
            try
            {
                await TrayRequestWithFallback(new[] { "/api/v1/runs/pause-all", "/api/runs/pause-all" }, "POST", new { });
            }
            catch (Exception ex)
            {
                TrayIcon?.ShowBalloonTip(1800, "NPA · 本地智能工作台", "暂停任务失败: " + ex.Message, ToolTipIcon.Warning);
            }
            if (form != null && !form.IsDisposed)
            {
                form.Close();
            }
            else
            {
                ActiveServer?.Dispose();
                DisposeTrayIcon();
                Application.ExitThread();
            }
        }

        private static async Task<string> TrayRequestWithFallback(string[] paths, string method, object body)
        {
            Exception last = null;
            foreach (string path in paths)
            {
                try
                {
                    return await TrayRequest(path, method, body);
                }
                catch (HttpRequestException ex) when (ex.Data["StatusCode"] is int status && (status == 404 || status == 405))
                {
                    last = ex;
                }
                catch (HttpRequestException ex)
                {
                    last = ex;
                    break;
                }
            }
            throw last ?? new InvalidOperationException("No tray API endpoint available.");
        }

        private static async Task<string> TrayRequest(string path, string method, object body)
        {
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) })
            using (HttpRequestMessage request = new HttpRequestMessage(new HttpMethod(method), new Uri(AppUrl + path)))
            {
                if (!string.IsNullOrWhiteSpace(SessionToken))
                {
                    request.Headers.TryAddWithoutValidation("X-Local-Session-Token", SessionToken);
                    request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + SessionToken);
                }
                if (body != null)
                {
                    request.Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json");
                }
                using (HttpResponseMessage response = await client.SendAsync(request))
                {
                    string payload = await response.Content.ReadAsStringAsync();
                    if (!response.IsSuccessStatusCode)
                    {
                        HttpRequestException error = new HttpRequestException("API " + (int)response.StatusCode + " " + response.ReasonPhrase);
                        error.Data["StatusCode"] = (int)response.StatusCode;
                        throw error;
                    }
                    return payload;
                }
            }
        }

        private static int CountPendingApprovals(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return 0;
            try
            {
                using (JsonDocument document = JsonDocument.Parse(body))
                {
                    JsonElement root = document.RootElement;
                    if (root.ValueKind == JsonValueKind.Array) return root.GetArrayLength();
                    foreach (string key in new[] { "approvals", "items", "pending" })
                    {
                        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out JsonElement value) && value.ValueKind == JsonValueKind.Array)
                        {
                            return value.GetArrayLength();
                        }
                    }
                }
            }
            catch
            {
            }
            return -1;
        }

        private static string ResolveSessionToken()
        {
            string[] names = { "WORKBENCH_SESSION_TOKEN", "WORKBENCH_TOKEN", "LOCAL_SESSION_TOKEN", "CODE_CLI_TOKEN", "SESSION_TOKEN" };
            foreach (string name in names)
            {
                string value = Environment.GetEnvironmentVariable(name) ?? "";
                if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
            }
            return "";
        }

        private static int StartChromeApp(string node, string root)
        {
            ServerLease server = EnsureServer(node, root);
            if (!WaitForServer(server.Url, root))
            {
                server.Dispose();
                MessageBox.Show("本地服务没有启动。可以尝试运行 ClaudeWorkbench.exe --cli 进入终端模式。", "NPA · 本地智能工作台");
                return 1;
            }

            string chrome = ResolveChrome();
            if (string.IsNullOrWhiteSpace(chrome))
            {
                server.Dispose();
                MessageBox.Show("未找到 Google Chrome。请安装 Chrome，或把 chrome.exe 加入 PATH 后再运行 ClaudeWorkbench.exe --chrome。", "NPA · 本地智能工作台");
                return 1;
            }

            Form form = new Form
            {
                Text = "NPA · 本地智能工作台 - Chrome",
                Width = 520,
                Height = 170,
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false
            };
            try
            {
                form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
            }

            Label label = new Label
            {
                Text = "本地服务正在运行。关闭这个窗口会停止服务。",
                Left = 18,
                Top = 18,
                Width = 470,
                Height = 24
            };
            TextBox urlBox = new TextBox
            {
                Text = server.Url,
                Left = 18,
                Top = 48,
                Width = 470,
                ReadOnly = true
            };
            Button openButton = new Button
            {
                Text = "打开 Chrome",
                Left = 18,
                Top = 82,
                Width = 120,
                Height = 30
            };
            Button closeButton = new Button
            {
                Text = "停止服务",
                Left = 368,
                Top = 82,
                Width = 120,
                Height = 30
            };
            openButton.Click += delegate { StartChrome(chrome, server.Url); };
            closeButton.Click += delegate { form.Close(); };
            form.Controls.Add(label);
            form.Controls.Add(urlBox);
            form.Controls.Add(openButton);
            form.Controls.Add(closeButton);
            form.FormClosed += delegate { server.Dispose(); };
            form.Shown += delegate { StartChrome(chrome, server.Url); };
            Application.Run(form);
            return 0;
        }

        private sealed class ServerLease : IDisposable
        {
            public Process Process;
            public string Url;
            public bool Reused;

            public void Dispose()
            {
                if (!Reused) TryKill(Process);
            }
        }

        private static ServerLease EnsureServer(string node, string root)
        {
            for (int port = DefaultPort; port < DefaultPort + 80; port++)
            {
                string url = "http://127.0.0.1:" + port;
                if (ProbeOwnedServer(url, root))
                {
                    AppUrl = url;
                    return new ServerLease { Process = null, Url = url, Reused = true };
                }
                if (ProbeHttp(url))
                {
                    continue;
                }
                Process process = StartServer(node, root, port);
                AppUrl = url;
                ServerLease lease = new ServerLease { Process = process, Url = url, Reused = false };
                if (WaitForServer(url, root)) return lease;
                lease.Dispose();
            }
            throw new InvalidOperationException("No available local port for ClaudeWorkbench.");
        }

        private static Process StartServer(string node, string root, int port)
        {
            string dataDir = ResolveWorkbenchDataDir();
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "server.js",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            SetChildEnvironment(info, "PORT", port.ToString());
            SetChildEnvironment(info, "WORKBENCH_DATA_DIR", dataDir);
            SetChildEnvironment(info, "WORKBENCH_INSTANCE_ID", ComputeInstanceId(root));
            Process process = Process.Start(info);
            if (process == null) throw new InvalidOperationException("无法启动 Node.js。");
            return process;
        }

        private static string ResolveChrome()
        {
            string envPath = Environment.GetEnvironmentVariable("CHROME_PATH") ?? "";
            if (File.Exists(envPath)) return envPath;

            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
            };
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }

            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathValue.Split(Path.PathSeparator))
            {
                try
                {
                    string candidate = Path.Combine(part.Trim(), "chrome.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                }
            }
            return "";
        }

        private static void StartChrome(string chrome, string url)
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = chrome,
                Arguments = "--new-window \"" + url + "\"",
                UseShellExecute = false
            };
            Process.Start(info);
        }

        private static bool ProbeHttp(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/health");
                request.Timeout = 500;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return (int)response.StatusCode >= 200 && (int)response.StatusCode < 500;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool ProbeOwnedServer(string url, string root)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/health");
                request.Timeout = 800;
                request.Headers["X-Workbench-Instance-Id"] = ComputeInstanceId(root);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    return body.Contains("\"app\":\"local-claude-workbench\"") && body.Contains("\"owned\":true");
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForServer(string url, string root)
        {
            for (int i = 0; i < 30; i++)
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/health");
                    request.Timeout = 1500;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 300 && ProbeOwnedServer(url, root)) return true;
                    }
                }
                catch
                {
                    Thread.Sleep(500);
                }
            }
            return false;
        }

        private static string ComputeInstanceId(string root)
        {
            string normalized = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            using (SHA256 sha = SHA256.Create())
            {
                return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
            }
        }

        private static void StartTerminal(string node, string root)
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "code-cli.js",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = false
            };
            SetChildEnvironment(info, "WORKBENCH_DATA_DIR", ResolveWorkbenchDataDir());
            Process.Start(info);
        }

        private static int RunProcess(string fileName, string arguments, string root, bool hidden, out string stdout, out string stderr)
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            SetChildEnvironment(info, "WORKBENCH_DATA_DIR", ResolveWorkbenchDataDir());
            using (Process process = Process.Start(info))
            {
                stdout = process.StandardOutput.ReadToEnd();
                stderr = process.StandardError.ReadToEnd();
                process.WaitForExit(30000);
                return process.ExitCode;
            }
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (process != null && !process.HasExited) process.Kill();
            }
            catch
            {
            }
        }

        private static void SetChildEnvironment(ProcessStartInfo info, string name, string value)
        {
            try
            {
                info.EnvironmentVariables[name] = value;
            }
            catch (ArgumentException)
            {
                Environment.SetEnvironmentVariable(name, value);
            }
        }
    }
}
