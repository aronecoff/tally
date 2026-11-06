import Foundation
import Security

/// The access URL, in the Keychain. `AfterFirstUnlockThisDeviceOnly` keeps it off
/// iCloud and out of device backups, so a new phone needs a new setup token.
struct Vault: SecretStore {
    static let service = "com.aronecoff.plainsum.simplefin"
    private static let account = "access-url"

    enum Failure: Error { case keychain(OSStatus) }

    private var item: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    func read() -> String? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ secret: String) throws {
        let values: [String: Any] = [
            kSecValueData as String: Data(secret.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var add = item.merging(values) { $1 }
        add[kSecAttrSynchronizable as String] = false
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem { status = SecItemUpdate(item as CFDictionary, values as CFDictionary) }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    func delete() throws {
        let status = SecItemDelete(item as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
    }

    /// Everything of the app's in the Keychain, whatever it is called. True once
    /// nothing is left. Keychain items outlive deleting the app (FirstLaunch.swift).
    static func purge() -> Bool {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ] as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
