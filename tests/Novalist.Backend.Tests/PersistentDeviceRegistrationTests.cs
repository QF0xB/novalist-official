using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Sync.Client.Tests;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentDeviceRegistrationTests
{
    [Fact]
    public async Task TheFirstSignInRegistersTheDeviceInTheSameBrowserVisit()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        server.KeyBoundEnrollment = true;
        identity.MultiFactorAuthentication = true;

        var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);

        Assert.True(account.DeviceRegistered);
        Assert.Equal(Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("recovery-device:", StringComparison.Ordinal)).Value,
            account.RecoveryToken);
        Assert.Equal(32, Convert.FromBase64String(account.RecoveryToken!).Length);
        Assert.Equal(1, identity.Authorizations);
        Assert.Equal("0", identity.RequestedMaxAge);
        var registration = Assert.Single(server.Registrations);
        var proof = Assert.IsType<PersistentSessionServer.EnrollmentProof>(registration.EnrollmentProof);
        Assert.Equal(Guid.Empty, proof.ChallengeId);
        var recovery = Assert.IsType<PersistentSessionServer.RecoveryRegistration>(registration.RecoveryDevice);
        Assert.Equal(ExpectedNonce(server.Address, registration.Keys, recovery.Keys, proof.Salt!), identity.LastNonce);
        Assert.Single(desktop.Credentials.Keys, key => key.StartsWith("device:", StringComparison.Ordinal));
        Assert.Single(desktop.Credentials.Keys, key => key.StartsWith("recovery-device:", StringComparison.Ordinal));
        var status = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address);
        Assert.True(status.DeviceRegistered);
        Assert.Null(status.RecoveryToken);

        await desktop.Rpc.InvokeAsync("collaboration/account/signOut", server.Address);
        var again = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);
        Assert.True(again.DeviceRegistered);
        Assert.Equal(2, identity.Authorizations);
        Assert.Equal(string.Empty, identity.RequestedMaxAge);
        Assert.Single(server.Registrations);
    }

    [Fact]
    public async Task KeysCreatedBeforeTheSignInAreConfirmedRatherThanReplaced()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        identity.MultiFactorAuthentication = true;
        await desktop.SignInAsync(server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        var device = Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("device:", StringComparison.Ordinal));
        desktop.Credentials.Remove(Assert.Single(desktop.Credentials.Keys, key => key.StartsWith("registered-devices:", StringComparison.Ordinal)));
        await desktop.Rpc.InvokeAsync("collaboration/account/signOut", server.Address);
        server.KeyBoundEnrollment = true;

        var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);

        Assert.True(account.DeviceRegistered);
        Assert.Equal(device.Value, desktop.Credentials[device.Key]);
        Assert.Equal(2, server.Registrations.Count);
        Assert.Equal(server.Registrations[0].Keys.DeviceId, server.Registrations[1].Keys.DeviceId);
        Assert.Null(server.Registrations[1].EnrollmentProof);
    }

    [Fact]
    public async Task ARejectedRegistrationStillSignsInAndCanBeRetried()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        server.KeyBoundEnrollment = true;
        server.RejectRegistration = true;
        identity.MultiFactorAuthentication = true;

        var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);

        Assert.False(account.DeviceRegistered);
        Assert.Null(account.RecoveryToken);
        Assert.Equal("Writer", (await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DisplayName);
        server.RejectRegistration = false;
        var enrolled = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/enrollDevice", server.Address);
        Assert.True(enrolled.DeviceRegistered);
        Assert.Equal(Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("recovery-device:", StringComparison.Ordinal)).Value,
            enrolled.RecoveryToken);
        Assert.True((await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
        Assert.Equal(2, identity.Authorizations);
    }

    [Fact]
    public async Task ARecoveryIdentityWithoutDeviceKeysLeavesRegistrationToTheAccountDetails()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var credentials = new Dictionary<string, string>
        {
            ["recovery-device:" + JsonSerializer.Serialize(new[] { identity.Authority.AbsoluteUri.TrimEnd('/'), "writer" })] =
                Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        };
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity, credentials);
        server.KeyBoundEnrollment = true;
        identity.MultiFactorAuthentication = true;

        var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);

        Assert.False(account.DeviceRegistered);
        Assert.DoesNotContain(desktop.Credentials.Keys, key => key.StartsWith("device:", StringComparison.Ordinal));
        Assert.Empty(server.Registrations);
    }

    [Fact]
    public async Task AnotherAccountOnARegisteredComputerSignsInWithoutForcedReauthentication()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        server.KeyBoundEnrollment = true;
        identity.MultiFactorAuthentication = true;
        await desktop.SignInAsync(server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/account/signOut", server.Address);
        identity.Subject = "second-writer";

        var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);

        Assert.Equal("second-writer", account.Subject);
        Assert.False(account.DeviceRegistered);
        Assert.Equal(string.Empty, identity.RequestedMaxAge);
    }

    [Fact]
    public async Task CancellingDuringRegistrationAbandonsTheSignIn()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        server.KeyBoundEnrollment = true;
        identity.MultiFactorAuthentication = true;
        var registering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.Connecting = registering;

        var signIn = desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);
        await registering.Task.WaitAsync(ct);
        await desktop.Rpc.InvokeAsync("collaboration/account/cancel");

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => signIn);
        server.Connecting = null;
        Assert.Null(await desktop.Rpc.InvokeAsync<HostedAccountDto?>("collaboration/account/status", server.Address));
    }

    private static string ExpectedNonce(Uri server, PersistentSessionServer.PublicKeys keys, PersistentSessionServer.PublicKeys recovery, byte[] salt)
    {
        var url = Encoding.UTF8.GetBytes(server.AbsoluteUri);
        var length = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(length, (ushort)url.Length);
        return Base64UrlEncoder.Encode(SHA256.HashData([.. "novalist/v1/device-enrollment"u8, .. length, .. url, .. Encode(keys), .. Encode(recovery), .. salt]));
    }

    private static byte[] Encode(PersistentSessionServer.PublicKeys keys) =>
        [.. keys.DeviceId.ToByteArray(bigEndian: true), .. keys.SigningPublicKey, .. keys.ReceivingPublicKey];
}
