using System.Text.Json;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using NSubstitute;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentIdentityResetTests
{
    [Fact]
    public async Task ResetCannotRunDuringSharingAndBrowserWaitsCanBeCancelledWithoutResetting()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.ResetSupported = true;
        var credentials = Substitute.For<ICollaborationCredentials>();
        credentials.ReadAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult<string?>(null));
        await using var accounts = new HostedAccounts(credentials);
        await accounts.SignInAsync(server.Address, identity.OpenBrowserAsync, ct);
        await using (var sharing = new HostedAccountRpc(accounts, identity.OpenBrowserAsync, _ => true))
            await Assert.ThrowsAsync<InvalidOperationException>(() => sharing.ResetIdentityAsync(server.Address, true, ct));
        // Use a separate account manager because disposing the RPC owns and closes its manager.
        await using var idleAccounts = new HostedAccounts(credentials);
        await idleAccounts.SignInAsync(server.Address, identity.OpenBrowserAsync, ct);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var rpc = new HostedAccountRpc(idleAccounts, async (_, token) =>
        {
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, token);
        });
        var resetting = rpc.ResetIdentityAsync(server.Address, true, ct);
        await entered.Task.WaitAsync(ct);
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.ResetIdentityAsync(server.Address, true, ct));
        rpc.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resetting);
        Assert.Equal(0, server.ResetCalls);
        Assert.False((await rpc.StatusAsync(server.Address, ct))!.DeviceRegistered);
    }

    [Fact]
    public async Task ResetUsesFreshMfaAndNewKeysWithoutDeletingOldCredentialsOrChangingOtherServers()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.KeyBoundEnrollment = true;
        server.ResetSupported = true;
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "writer"), identity);
        await desktop.SignInAsync(server.Address);
        var oldDevice = Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("device:", StringComparison.Ordinal));
        var oldRecovery = Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("recovery-device:", StringComparison.Ordinal));
        var beforeAuthorizations = identity.Authorizations;

        var reset = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/resetIdentity", server.Address, true);

        Assert.True(reset.DeviceRegistered);
        Assert.Equal(32, Convert.FromBase64String(reset.RecoveryToken!).Length);
        Assert.NotEqual(oldRecovery.Value, reset.RecoveryToken);
        Assert.Equal("writer", reset.Subject);
        Assert.Equal(beforeAuthorizations + 2, identity.Authorizations);
        Assert.Equal("0", identity.RequestedMaxAge);
        Assert.Equal(1, server.ResetCalls);
        Assert.Equal(oldDevice.Value, desktop.Credentials[oldDevice.Key]);
        Assert.Equal(oldRecovery.Value, desktop.Credentials[oldRecovery.Key]);
        var saved = Assert.Single(desktop.Credentials, pair => pair.Key.StartsWith("hosted-account:", StringComparison.Ordinal));
        Assert.Contains("reset:" + server.ResetUser, saved.Value);
        Assert.True((await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
        Assert.Equal(2, desktop.Credentials.Keys.Count(key => key.StartsWith("device:", StringComparison.Ordinal)));
        Assert.NotEqual(server.Registrations[0].Keys.DeviceId, server.Registrations[1].Keys.DeviceId);
        await desktop.Rpc.InvokeAsync("collaboration/account/signOut", server.Address);
        await desktop.SignInAsync(server.Address);
        // The persisted namespace is restored on the next sign-in, rather than falling back to old keys.
        Assert.True((await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);

        await using var other = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await desktop.SignInAsync(other.Address);
        await desktop.Rpc.InvokeAsync("collaboration/account/enrollDevice", other.Address);
        Assert.Equal(server.Registrations[0].Keys.DeviceId, Assert.Single(other.Registrations).Keys.DeviceId);
    }

    [Fact]
    public async Task FailedAutomaticEnrollmentReturnsTheResetIdentityAndAllowsRetry()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.KeyBoundEnrollment = true;
        server.ResetSupported = true;
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "writer"), identity);
        await desktop.SignInAsync(server.Address);
        server.RejectRegistration = true;

        var reset = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/resetIdentity", server.Address, true);

        Assert.Equal(1, server.ResetCalls);
        Assert.False(reset.DeviceRegistered);
        Assert.NotEmpty(reset.DeviceRegistrationError!);
        Assert.Null(reset.RecoveryToken);
        server.RejectRegistration = false;
        var registered = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/enrollDevice", server.Address);
        Assert.True(registered.DeviceRegistered);
        Assert.NotNull(registered.RecoveryToken);
        Assert.Equal(1, server.ResetCalls);
    }

    [Theory]
    [InlineData("no-confirmation")]
    [InlineData("unsupported")]
    [InlineData("rejected")]
    public async Task RefusedResetLeavesTheLocalIdentityUnchanged(string reason)
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.ResetSupported = reason != "unsupported";
        server.RejectReset = reason == "rejected";
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "writer"), identity);
        await desktop.SignInAsync(server.Address);
        var before = JsonSerializer.Serialize(desktop.Credentials.OrderBy(pair => pair.Key));

        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync<HostedAccountDto>(
            "collaboration/account/resetIdentity", server.Address, reason != "no-confirmation"));

        Assert.Equal(before, JsonSerializer.Serialize(desktop.Credentials.OrderBy(pair => pair.Key)));
        Assert.Equal(reason == "rejected" ? 1 : 0, server.ResetCalls);
    }
}
