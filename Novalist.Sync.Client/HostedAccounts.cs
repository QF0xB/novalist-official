using System.Text.Json;

namespace Novalist.Sync.Client;

public interface ICollaborationCredentials
{
    Task<string?> ReadAsync(string key, CancellationToken ct);
    Task WriteAsync(string key, string value, CancellationToken ct);
    Task RemoveAsync(string key, CancellationToken ct);
}

public sealed partial class HostedAccounts : IAsyncDisposable
{
    private readonly ICollaborationCredentials credentials;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, HostedAccount> accounts = [];
    private readonly object lifecycle = new();
    private readonly CancellationTokenSource lifetime = new();
    private Task? closing;
    private readonly IHostedSignInBrowser? browser;

    public HostedAccounts(ICollaborationCredentials credentials, IHostedSignInBrowser? browser = null)
    {
        this.credentials = credentials;
        this.browser = browser;
    }

    public async Task<HostedAccount> SignInAsync(Uri server, Func<Uri, CancellationToken, Task> openBrowser, CancellationToken ct)
    {
        var key = AccountKey(server);
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        await gate.WaitAsync(ct);
        try
        {
            if (accounts.ContainsKey(key)) throw new InvalidOperationException("Sign out of this server before signing in again.");
            var configuration = await RelayServerDiscovery.DiscoverAsync(server, ct);
            var settings = configuration.SignIn ?? throw new InvalidOperationException("This server does not require sign-in.");
            var account = configuration.KeyBoundEnrollment && !await HasRegisteredDeviceAsync(server, ct)
                ? await SignInAndRegisterAsync(server, settings, openBrowser, ct)
                : browser is null ? await HostedSignIn.SignInAsync(settings, openBrowser, ct) : await HostedSignIn.SignInAsync(settings, browser, ct);
            try
            {
                await RestoreDeviceSubjectAsync(server, account, ct);
                await account.RememberAsync(credentials, key, ct);
                ct.ThrowIfCancellationRequested();
                accounts.Add(key, account);
                return account;
            }
            catch { await account.DisposeAsync(); throw; }
        }
        finally { gate.Release(); }
    }

    public async Task<HostedAccount?> RestoreAsync(Uri server, CancellationToken ct)
    {
        var key = AccountKey(server);
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        await gate.WaitAsync(ct);
        try
        {
            if (accounts.TryGetValue(key, out var existing)) return existing;
            var saved = await credentials.ReadAsync(key, ct);
            ct.ThrowIfCancellationRequested();
            if (saved is null) return null;
            var state = JsonSerializer.Deserialize<HostedAccountState>(saved);
            if (state is not { Version: 1, Settings: not null } || string.IsNullOrWhiteSpace(state.Subject) ||
                string.IsNullOrEmpty(state.RefreshToken) || string.IsNullOrEmpty(state.Nonce))
                throw new InvalidDataException("The saved sign-in is incomplete. Please sign in again.");
            var account = HostedSignIn.Restore(state, credentials, key);
            accounts.Add(key, account);
            return account;
        }
        finally { gate.Release(); }
    }

    public async Task SignOutAsync(Uri server, CancellationToken ct)
    {
        var key = AccountKey(server);
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        await gate.WaitAsync(ct);
        try
        {
            if (accounts.TryGetValue(key, out var account)) await account.ForgetAsync(ct);
            else await credentials.RemoveAsync(key, ct);
            accounts.Remove(key);
            registrationErrors.TryRemove(key, out _);
        }
        finally { gate.Release(); }
    }

    public async Task<HostedAccount> EnrollDeviceAsync(Uri server, Func<Uri, CancellationToken, Task> openBrowser, CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        var account = await RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in before registering this device.");
        var devices = new DeviceIdentityStore(credentials);
        using var device = await devices.GetOrCreateAsync(account.Authority, account.DeviceSubject, ct);
        var key = RecoveryKey(account);
        var saved = await credentials.ReadAsync(key, ct);
        var recoveryKey = saved is null ? System.Security.Cryptography.RandomNumberGenerator.GetBytes(32) : Convert.FromBase64String(saved);
        try
        {
            if (saved is null) await credentials.WriteAsync(key, Convert.ToBase64String(recoveryKey), ct);
            using var recovery = RecoveryDeviceIdentity.Derive(recoveryKey);
            if (browser is null) await HostedDeviceEnrollment.EnrollAsync(server, device, recovery, account, openBrowser, ct);
            else await HostedDeviceEnrollment.EnrollAsync(server, device, recovery, account, browser, ct);
            await MarkRegisteredAsync(server, account, ct);
            return account;
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(recoveryKey); }
    }

    private CancellationTokenSource BeginOperation(CancellationToken ct)
    {
        lock (lifecycle)
        {
            ObjectDisposedException.ThrowIf(closing is not null, this);
            return CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.Token);
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (lifecycle)
        {
            if (closing is { IsFaulted: true } or { IsCanceled: true }) closing = null;
            return new(closing ??= CloseAsync());
        }
    }

    private async Task CloseAsync()
    {
        lifetime.Cancel();
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            foreach (var account in accounts.Values) await account.DisposeAsync().ConfigureAwait(false);
            accounts.Clear();
            lifetime.Dispose();
        }
        finally { gate.Release(); }
    }

    private static string AccountKey(Uri server)
    {
        HostedSignIn.ValidateAddress(server);
        return "hosted-account:" + server.AbsoluteUri.TrimEnd('/');
    }
}

internal sealed class HostedAccountState
{
    public int Version { get; init; } = 1;
    public HostedSignInOptions? Settings { get; init; }
    public string Subject { get; init; } = string.Empty;
    public string? DeviceSubject { get; init; }
    public string DisplayName { get; init; } = string.Empty;
    public string Nonce { get; init; } = string.Empty;
    public string RefreshToken { get; init; } = string.Empty;
}
