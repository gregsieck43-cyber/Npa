using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Security.Principal;
class ResourceProbe {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protection);
    [DllImport("kernel32.dll")] static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    delegate bool WindowVisitor(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "arguments") {
            IntPtr job = OpenJobObject(4, false, "Local\\NPN-Gamma-Memory-" + WindowsIdentity.GetCurrent().User.Value);
            bool inside;
            bool budgeted = job != IntPtr.Zero && IsProcessInJob(new IntPtr(-1), job, out inside) && inside;
            if (job != IntPtr.Zero) CloseHandle(job);
            Console.WriteLine(budgeted ? "budgeted-before-entry" : "missing-budget");
            foreach (string argument in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(argument)));
            return budgeted ? 37 : 1;
        }
        if (args.Length == 2 && args[0] == "close-window") {
            using (var process = Process.GetProcessById(Int32.Parse(args[1]))) {
                for (int i = 0; i < 100; i++) {
                    process.Refresh();
                    IntPtr owned = IntPtr.Zero;
                    EnumWindows((window, ignored) => {
                        uint pid; GetWindowThreadProcessId(window, out pid);
                        if (pid == process.Id) {
                            var title = new StringBuilder(256); GetWindowText(window, title, title.Capacity);
                            var kind = new StringBuilder(256); GetClassName(window, kind, kind.Capacity);
                            if (i == 0) Console.WriteLine(kind + " | " + title);
                            if (kind.ToString() == "Chrome_WidgetWin_1" && title.Length > 0) { owned = window; return false; }
                        }
                        return true;
                    }, IntPtr.Zero);
                    if (owned != IntPtr.Zero) {
                        if (!PostMessage(owned, 0x10, IntPtr.Zero, IntPtr.Zero)) return 1;
                        bool exited = process.WaitForExit(5000);
                        Console.WriteLine("Native process signalled exit: " + exited);
                        return exited ? 0 : 3;
                    }
                    Thread.Sleep(50);
                }
                return 2;
            }
        }
        Console.WriteLine("ready"); Console.ReadLine();
        IntPtr small = VirtualAlloc(IntPtr.Zero, new UIntPtr(16 * 1024 * 1024), 0x3000, 4);
        IntPtr large = VirtualAlloc(IntPtr.Zero, new UIntPtr(512 * 1024 * 1024), 0x3000, 4);
        Console.WriteLine("{\"smallAllowed\":" + (small != IntPtr.Zero ? "true" : "false") + ",\"largeDenied\":" + (large == IntPtr.Zero ? "true" : "false") + "}");
        if (small != IntPtr.Zero) VirtualFree(small, UIntPtr.Zero, 0x8000);
        if (large != IntPtr.Zero) VirtualFree(large, UIntPtr.Zero, 0x8000);
        return small != IntPtr.Zero && large == IntPtr.Zero ? 0 : 1;
    }
}
