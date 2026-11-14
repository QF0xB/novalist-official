#if NOVALIST_COLLABORATION
using Novalist.Sync.Client;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed record HostedAccountDto(string Subject, string DisplayName, bool DeviceRegistered, string? DeviceRegistrationError = null,
    string? RecoveryToken = null);

public sealed class HostedAccountRpc : IAsyncDisposable
{
    private readonly HostedAccounts accounts;
    private readonly Func<Uri, CancellationToken, Task> openBrowser;
    private readonly Func<Uri, bool> isSharing;
    private readonly object gate = new();
    private CancellationTokenSource? signIn;

    public HostedAccountRpc(HostedAccounts accounts, Func<Uri, CancellationToken, Task> openBrowser, Func<Uri, bool>? isSharing = null)
    {
        this.accounts = accounts;
        this.openBrowser = openBrowser;
        this.isSharing = isSharing ?? (_ => false);
    }

    [JsonRpcMethod("collaboration/account/signIn")]
    public async Task<HostedAccountDto> SignInAsync(Uri server, CancellationToken cancellationToken = default)
    {
        CancellationTokenSource operation;
        lock (gate)
        {
            if (signIn is not null) throw new InvalidOperationException("A sign-in is already in progress.");
            signIn = operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        }
        try { return await ViewAsync(server, await accounts.SignInAsync(server, openBrowser, operation.Token), operation.Token, true); }
        finally
        {
            lock (gate) { signIn = null; operation.Dispose(); }
        }
    }

    [JsonRpcMethod("collaboration/account/configuration")]
    public Task<RelayServerConfiguration> ConfigurationAsync(Uri server, CancellationToken cancellationToken = default) =>
        RelayServerDiscovery.DiscoverAsync(server, cancellationToken);

    [JsonRpcMethod("collaboration/account/enrollDevice")]
    public async Task<HostedAccountDto> EnrollDeviceAsync(Uri server, CancellationToken cancellationToken = default)
    {
        CancellationTokenSource operation;
        lock (gate)
        {
            if (signIn is not null) throw new InvalidOperationException("A sign-in is already in progress.");
            signIn = operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        }
        try
        {
            var account = await accounts.EnrollDeviceAsync(server, openBrowser, operation.Token);
            return await ViewAsync(server, account, operation.Token, true);
        }
        finally { lock (gate) { signIn = null; operation.Dispose(); } }
    }

    [JsonRpcMethod("collaboration/account/resetIdentity")]
    public async Task<HostedAccountDto> ResetIdentityAsync(Uri server, bool forfeitProjectAccess, CancellationToken cancellationToken = default)
    {
        if (isSharing(server)) throw new InvalidOperationException("End the collaboration session before resetting this identity.");
        CancellationTokenSource operation;
        lock (gate)
        {
            if (signIn is not null) throw new InvalidOperationException("A sign-in is already in progress.");
            signIn = operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        }
        try
        {
            var account = await accounts.ResetIdentityAsync(server, forfeitProjectAccess, openBrowser, operation.Token);
            try { await accounts.EnrollDeviceAsync(server, openBrowser, operation.Token); }
            catch (Exception error) when (!operation.IsCancellationRequested && error is HttpRequestException or InvalidOperationException or
                InvalidDataException or System.Security.Cryptography.CryptographicException or System.Text.Json.JsonException or OperationCanceledException)
            {
                return new(account.Subject, account.DisplayName, false, error.Message);
            }
            return await ViewAsync(server, account, operation.Token, true);
        }
        finally { lock (gate) { signIn = null; operation.Dispose(); } }
    }

    [JsonRpcMethod("collaboration/account/status")]
    public async Task<HostedAccountDto?> StatusAsync(Uri server, CancellationToken cancellationToken = default)
    {
        var account = await accounts.RestoreAsync(server, cancellationToken);
        if (account is null) return null;
        try
        {
            if (!isSharing(server)) _ = await account.GetAccessTokenAsync(cancellationToken);
            return await ViewAsync(server, account, cancellationToken);
        }
        catch (UnauthorizedAccessException)
        {
            await accounts.SignOutAsync(server, cancellationToken);
            return null;
        }
    }

    [JsonRpcMethod("collaboration/account/signOut")]
    public Task SignOutAsync(Uri server, CancellationToken cancellationToken = default)
    {
        if (isSharing(server)) throw new InvalidOperationException("End the collaboration session before signing out.");
        return accounts.SignOutAsync(server, cancellationToken);
    }

    [JsonRpcMethod("collaboration/account/cancel")]
    public void Cancel() { lock (gate) signIn?.Cancel(); }

    private async Task<HostedAccountDto> ViewAsync(Uri server, HostedAccount account, CancellationToken ct, bool includeRecovery = false) =>
        await accounts.IsDeviceRegisteredAsync(server, account, ct)
            ? new(account.Subject, account.DisplayName, true, RecoveryToken: includeRecovery ? await accounts.GetRecoveryTokenAsync(account, ct) : null)
            : new(account.Subject, account.DisplayName, false, accounts.DeviceRegistrationError(server));

    public async ValueTask DisposeAsync()
    {
        Cancel();
        await accounts.DisposeAsync().ConfigureAwait(false);
    }
}
#endif
