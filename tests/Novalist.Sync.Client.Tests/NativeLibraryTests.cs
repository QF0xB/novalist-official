using Xunit;
using YDotNet.Document;

namespace Novalist.Sync.Client.Tests;

public class NativeLibraryTests
{
    [Fact]
    public void Document_CanWriteAndReadUnicodeText()
    {
        using var document = new Doc();
        var text = document.Text("content");

        using (var transaction = document.WriteTransaction())
        {
            text.Insert(transaction, 0, "Hello, Grüezi - 世界");
            transaction.Commit();
        }

        using var readTransaction = document.ReadTransaction();
        
        Assert.Equal(
            "Hello, Grüezi - 世界", 
            text.String(readTransaction));
    }
}