using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

namespace Novalist.Sync.Client;

public sealed partial class HostedAccounts
{
    private readonly ConcurrentDictionary<string, string> registrationErrors = new(StringComparer.Ordinal);

    // A first sign-in on a server that accepts key-bound proofs registers the device in the same browser visit:
    // the identities exist before sign-in and the sign-in nonce is derived from their public keys. When an earlier
    // attempt on this server left unregistered keys behind, the nonce covers those keys so the retry can prove them.
    private async Task<HostedAccount> SignInAndRegisterAsync(Uri server, HostedSignInOptions settings,
        Func<Uri, CancellationToken, Task> openBrowser, CancellationToken ct)
    {
        await using var keys = await PrepareKeysAsync(server, ct);
        var salt = RandomNumberGenerator.GetBytes(32);
        var nonce = HostedDeviceEnrollment.EnrollmentNonce(server, keys.Device, keys.Recovery, salt);
        var (account, identityToken) = browser is null
            ? await HostedSignIn.SignInForEnrollmentAsync(settings, nonce, openBrowser, ct)
            : await HostedSignIn.SignInForEnrollmentAsync(settings, nonce, browser, ct);
        registrationErrors.TryRemove(AccountKey(server), out _);
        try
        {
            await RestoreDeviceSubjectAsync(server, account, ct);
            await credentials.WriteAsync(PendingKey(server), AccountName(account), ct);
            await RegisterSignedInDeviceAsync(server, account, keys, identityToken, salt, ct);
        }
        catch (Exception error) when (!ct.IsCancellationRequested && error is HttpRequestException or InvalidOperationException or
            InvalidDataException or CryptographicException or JsonException or OperationCanceledException)
        {
            // The sign-in itself succeeded; account details show why the device is not registered and offer a retry.
            registrationErrors[AccountKey(server)] = error.Message;
        }
        catch { await account.DisposeAsync(); throw; }
        return account;
    }

    private async Task<PreparedKeys> PrepareKeysAsync(Uri server, CancellationToken ct)
    {
        var pending = await credentials.ReadAsync(PendingKey(server), ct);
        var owner = pending is null ? null : JsonSerializer.Deserialize<string[]>(pending);
        if (owner is [var authority, var subject] && !(await RegisteredAccountsAsync(server, ct)).Contains(pending!))
        {
            var devices = new DeviceIdentityStore(credentials);
            var savedRecovery = await credentials.ReadAsync(RecoveryKey(pending!), ct);
            if (savedRecovery is not null && await devices.ExistsAsync(new Uri(authority), subject, ct))
                return new(pending, await devices.GetOrCreateAsync(new Uri(authority), subject, ct), Convert.FromBase64String(savedRecovery), null);
        }
        return new(null, null, RandomNumberGenerator.GetBytes(32), DeviceIdentityStore.CreateCandidate());
    }

    private async Task RegisterSignedInDeviceAsync(Uri server, HostedAccount account, PreparedKeys keys, string identityToken, byte[] salt,
        CancellationToken ct)
    {
        var name = AccountName(account);
        if (keys.Owner is not null)
        {
            // The nonce covers keys an earlier attempt saved for one account; a different account cannot use them.
            if (keys.Owner != name)
                throw new InvalidOperationException("This device was preparing keys for another account. Use Register this device.");
        }
        else
        {
            var devices = new DeviceIdentityStore(credentials);
            if (await devices.ExistsAsync(account.Authority, account.DeviceSubject, ct))
            {
                // Keys from before this sign-in, which its nonce does not cover: accepted only if already registered.
                using var existing = await devices.GetOrCreateAsync(account.Authority, account.DeviceSubject, ct);
                await HostedDeviceEnrollment.ConfirmAsync(server, existing, account, ct);
                await MarkRegisteredAsync(server, account, ct);
                return;
            }
            if (await credentials.ReadAsync(RecoveryKey(name), ct) is not null)
                throw new InvalidOperationException("This device has a recovery identity without device keys. Use Register this device.");
            if (!await devices.TryAdoptAsync(account.Authority, account.DeviceSubject, keys.Candidate!, ct))
                throw new InvalidOperationException("Another sign-in created this device's keys first. Use Register this device.");
            await credentials.WriteAsync(RecoveryKey(name), Convert.ToBase64String(keys.RecoveryKey), ct);
        }
        await HostedDeviceEnrollment.EnrollKeyBoundAsync(server, keys.Device, keys.Recovery, account, identityToken, salt, ct);
        await MarkRegisteredAsync(server, account, ct);
    }

    public async Task<bool> IsDeviceRegisteredAsync(Uri server, HostedAccount account, CancellationToken ct) =>
        (await RegisteredAccountsAsync(server, ct)).Contains(AccountName(account));

    // Why the last sign-in on this server did not register the device, until a later attempt succeeds.
    public string? DeviceRegistrationError(Uri server) => registrationErrors.GetValueOrDefault(AccountKey(server));

    public Task<string?> GetRecoveryTokenAsync(HostedAccount account, CancellationToken ct) =>
        credentials.ReadAsync(RecoveryKey(account), ct);

    private async Task<bool> HasRegisteredDeviceAsync(Uri server, CancellationToken ct) => (await RegisteredAccountsAsync(server, ct)).Count > 0;

    private async Task MarkRegisteredAsync(Uri server, HostedAccount account, CancellationToken ct)
    {
        registrationErrors.TryRemove(AccountKey(server), out _);
        await credentials.RemoveAsync(PendingKey(server), ct);
        var registered = await RegisteredAccountsAsync(server, ct);
        if (registered.Add(AccountName(account)))
            await credentials.WriteAsync(RegisteredKey(server), JsonSerializer.Serialize(registered.Order(StringComparer.Ordinal)), ct);
    }

    private async Task<HashSet<string>> RegisteredAccountsAsync(Uri server, CancellationToken ct)
    {
        var saved = await credentials.ReadAsync(RegisteredKey(server), ct);
        return saved is null ? new(StringComparer.Ordinal) : new(JsonSerializer.Deserialize<string[]>(saved) ?? [], StringComparer.Ordinal);
    }

    private static string AccountName(HostedAccount account) =>
        JsonSerializer.Serialize(new[] { account.Authority.AbsoluteUri.TrimEnd('/'), account.DeviceSubject });

    private static string RecoveryKey(HostedAccount account) => RecoveryKey(AccountName(account));
    private static string RecoveryKey(string accountName) => "recovery-device:" + accountName;

    // Accounts whose device identity on this computer the server has accepted. Kept across sign-out.
    private static string RegisteredKey(Uri server)
    {
        HostedSignIn.ValidateAddress(server);
        return "registered-devices:" + server.AbsoluteUri.TrimEnd('/');
    }

    // The account whose keys a key-bound sign-in on this server prepared and has not registered yet.
    private static string PendingKey(Uri server)
    {
        HostedSignIn.ValidateAddress(server);
        return "pending-device-registration:" + server.AbsoluteUri.TrimEnd('/');
    }

    // The ordinary and recovery identities a key-bound sign-in's nonce is derived from.
    private sealed class PreparedKeys : IAsyncDisposable
    {
        public string? Owner { get; }
        public DeviceIdentityStore.DeviceCandidate? Candidate { get; }
        public byte[] RecoveryKey { get; }
        public DeviceIdentity Device { get; }
        public DeviceIdentity Recovery { get; }
        private readonly DeviceIdentity? saved;

        public PreparedKeys(string? owner, DeviceIdentity? saved, byte[] recoveryKey, DeviceIdentityStore.DeviceCandidate? candidate)
        {
            Owner = owner;
            this.saved = saved;
            Candidate = candidate;
            RecoveryKey = recoveryKey;
            Device = saved ?? candidate!.Identity;
            Recovery = RecoveryDeviceIdentity.Derive(recoveryKey);
        }

        public ValueTask DisposeAsync()
        {
            Recovery.Dispose();
            saved?.Dispose();
            Candidate?.Dispose();
            CryptographicOperations.ZeroMemory(RecoveryKey);
            return ValueTask.CompletedTask;
        }
    }
}
