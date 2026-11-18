// Windows job ownership and accounting. No WMI, process polling in the UI, or third-party runtime.
// A shared per-user job includes all installations/data directories and inherited descendants.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.IO;
using System.Text;

class ResourceBudget {
    [StructLayout(LayoutKind.Sequential)] struct MemoryStatus {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtended;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Usage { public ulong JobMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
        public uint Size, Usage, Id;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Exe;
    }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits data, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int MessageBox(IntPtr owner, string text, string title, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref MemoryStatus memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static MemoryStatus Memory() {
        var result = new MemoryStatus(); result.Length = (uint)Marshal.SizeOf(result);
        Check(GlobalMemoryStatusEx(ref result), "Read physical memory"); return result;
    }
    static void Attach(IntPtr job, uint pid, bool required) {
        // SET_QUOTA | TERMINATE | QUERY_LIMITED_INFORMATION; no breakaway flag is granted.
        IntPtr process = OpenProcess(0x1101, false, pid);
        if (process == IntPtr.Zero) {
            if (!required && Marshal.GetLastWin32Error() == 87) return; // exited during enumeration
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Open owned process " + pid);
        }
        try {
            bool inside;
            Check(IsProcessInJob(process, job, out inside), "Query owned job");
            if (!inside && !AssignProcessToJobObject(job, process)) {
                int error = Marshal.GetLastWin32Error(); uint code;
                if (!required && GetExitCodeProcess(process, out code) && code != 259) return;
                throw new Win32Exception(error, "Attach owned process " + pid);
            }
        } finally { CloseHandle(process); }
    }
    static void AttachExistingChildren(IntPtr job, uint owner) {
        // Chromium can create children before its JS main entry runs. Attach the owner first so
        // all subsequent children inherit, then cover the already-created descendants.
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var entries = new List<ProcessEntry>();
        try {
            var entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(entry);
            if (Process32First(snapshot, ref entry)) do { entries.Add(entry); } while (Process32Next(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        var owned = new HashSet<uint>(); owned.Add(owner);
        uint self = (uint)Process.GetCurrentProcess().Id;
        bool added;
        do {
            added = false;
            foreach (var entry in entries) if (entry.Id != self && owned.Contains(entry.Parent) && !owned.Contains(entry.Id)) {
                Attach(job, entry.Id, false); owned.Add(entry.Id); added = true;
            }
        } while (added);
    }
    static void KeepNamedJobAlive(IntPtr job, uint owner) {
        // Membership keeps limits alive, but the named object needs an open HANDLE so another
        // independently launched root opens the SAME group. One non-inherited handle per root
        // is held for that process's lifetime and released automatically by Windows on exit.
        IntPtr process = OpenProcess(0x40, false, owner);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open resource owner");
        try {
            IntPtr copy;
            Check(DuplicateHandle(new IntPtr(-1), job, process, out copy, 0, false, 2), "Retain shared job in owner");
        } finally { CloseHandle(process); }
    }
    static T Query<T>(IntPtr job, int kind) {
        int size = Marshal.SizeOf(typeof(T)); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Check(QueryInformationJobObject(job, kind, buffer, (uint)size, IntPtr.Zero), "Read job accounting"); return (T)Marshal.PtrToStructure(buffer, typeof(T)); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static List<int> ProcessIds(IntPtr job) {
        for (int size = 4096; size <= 1048576; size *= 2) {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                if (!QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero)) {
                    if (Marshal.GetLastWin32Error() == 234) continue;
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Read job processes");
                }
                int count = Marshal.ReadInt32(buffer, 4); var ids = new List<int>(count);
                for (int i = 0; i < count; i++) ids.Add(Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt32());
                return ids;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Resource process list exceeds 1 MiB.");
    }
    static void Report(IntPtr job) {
        var memory = Memory(); var usage = Query<Usage>(job, 28); var limits = Query<Limits>(job, 9);
        var ids = ProcessIds(job); long workingSet = 0, privateBytes = 0, handles = 0;
        foreach (int id in ids) {
            try { using (var process = Process.GetProcessById(id)) {
                workingSet += process.WorkingSet64; privateBytes += process.PrivateMemorySize64; handles += process.HandleCount;
            } }
            catch (ArgumentException) { /* exited */ }
            catch (InvalidOperationException) { /* exited */ }
        }
        Console.WriteLine("{\"physicalBytes\":" + memory.TotalPhysical + ",\"availableBytes\":" + memory.AvailablePhysical
            + ",\"limitBytes\":" + limits.JobMemory.ToUInt64() + ",\"commitBytes\":" + usage.JobMemory
            + ",\"peakCommitBytes\":" + usage.PeakJobMemory + ",\"workingSetBytes\":" + workingSet
            + ",\"privateBytes\":" + privateBytes + ",\"handles\":" + handles
            + ",\"processes\":" + ids.Count + ",\"processIds\":[" + String.Join(",", ids.GetRange(0, Math.Min(ids.Count, 256))) + "],\"hardLimited\":true}");
    }
    static IntPtr CreateBudget(string suffix, ulong requested) {
        string name = "Local\\NPN-Gamma-Memory-" + WindowsIdentity.GetCurrent().User.Value + suffix;
        ulong ceiling = Math.Min(Memory().TotalPhysical / 10 * 6, 8UL * 1024 * 1024 * 1024);
        ulong limit = Math.Min(ceiling, requested);
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create shared memory job");
        try {
            var limits = Query<Limits>(job, 9);
            if (limits.JobMemory.ToUInt64() != 0) limit = Math.Min(limit, limits.JobMemory.ToUInt64());
            limits.Basic.Flags |= 0x200; limits.JobMemory = new UIntPtr(limit);
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "Set shared memory limit");
            return job;
        } catch { CloseHandle(job); throw; }
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static int Launch(IntPtr job, string executable, string[] arguments, bool diagnostic) {
        Attach(job, (uint)Process.GetCurrentProcess().Id, true);
        var command = new StringBuilder(Quote(executable));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        var startup = new StartupInfo(); startup.Size = (uint)Marshal.SizeOf(startup);
        startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
        if (startup.Output != IntPtr.Zero && startup.Output != new IntPtr(-1)) {
            startup.Flags = 0x100;
            foreach (IntPtr handle in new[] { startup.Input, startup.Output, startup.Error })
                if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Check(SetHandleInformation(handle, 1, 1), "Forward launch pipe");
        }
        ProcessInfo child;
        Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero, null, ref startup, out child), "Create suspended desktop");
        bool resumed = false;
        try {
            Attach(job, child.Id, true); KeepNamedJobAlive(job, child.Id);
            if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume budgeted desktop");
            resumed = true;
            if (diagnostic) Console.WriteLine("NPN_DESKTOP_PID=" + child.Id);
            if (WaitForSingleObject(child.Process, UInt32.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for desktop exit");
            uint code; Check(GetExitCodeProcess(child.Process, out code), "Read desktop exit");
            return unchecked((int)code);
        } finally {
            if (!resumed) TerminateProcess(child.Process, 1);
            CloseHandle(child.Thread); CloseHandle(child.Process);
        }
    }
    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        try {
#if DESKTOP_LAUNCHER
            job = CreateBudget("", UInt64.MaxValue);
            return Launch(job, Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "NPN-Gamma-Desktop.exe"), args, false);
#else
            int launchIndex = Array.IndexOf(args, "launch");
            if (launchIndex >= 0 && launchIndex + 1 < args.Length && args[0] != "attach" && args[0] != "watch") {
                job = CreateBudget("", UInt64.MaxValue);
                var forwarded = new string[args.Length - 2];
                Array.Copy(args, 0, forwarded, 0, launchIndex);
                Array.Copy(args, launchIndex + 2, forwarded, launchIndex, args.Length - launchIndex - 2);
                return Launch(job, Path.GetFullPath(args[launchIndex + 1]), forwarded, true);
            }
            if (args.Length < 2 || (args[0] != "attach" && args[0] != "watch")) throw new ArgumentException("Expected attach/watch and owner PID.");
            uint owner = UInt32.Parse(args[1]);
            // Only tests pass a suffix and a *lower* budget. Production always uses this same SID job.
            string suffix = args.Length > 2 ? "-" + args[2] : "";
            // Leave room for the OS and other applications, and stop the product reaching 12 GiB
            // even on large-memory machines. This is committed memory, not a claim about RSS.
            job = CreateBudget(suffix, args.Length > 3 ? UInt64.Parse(args[3]) : UInt64.MaxValue);
            Attach(job, owner, true); Attach(job, (uint)Process.GetCurrentProcess().Id, true);
            AttachExistingChildren(job, owner);
            KeepNamedJobAlive(job, owner);
            Report(job);
            if (args[0] == "watch") {
                // Closing the pipe releases this helper, never kills the durable backend or tools.
                var input = new Thread(() => { try { while (Console.Read() != -1) {} } finally { Environment.Exit(0); } });
                input.IsBackground = true; input.Start();
                while (true) { Thread.Sleep(2000); Report(job); }
            }
            return 0;
#endif
        } catch (Exception error) {
            string message = error.Message + (error is Win32Exception ? " (Win32 " + ((Win32Exception)error).NativeErrorCode + ")" : "");
#if DESKTOP_LAUNCHER
            MessageBox(IntPtr.Zero, message, "NPN-Gamma 启动失败", 0x10);
#else
            Console.Error.WriteLine(message);
#endif
            return 1;
        }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
