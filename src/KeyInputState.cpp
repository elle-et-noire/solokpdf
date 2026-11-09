/* Copyright 2026 the SolokPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "KeyInputState.h"

PendingKeys KeyInputState::Get() const {
    return pending;
}

// A leading zero stays available to shortcuts; later zeros extend the count.
bool KeyInputState::AddDigit(int key) {
    if (pending.prefix || key < '0' || key > '9' || (key == '0' && !pending.count)) {
        return false;
    }

    constexpr int kMaxKeyCount = 9999;
    pending.count = std::min(kMaxKeyCount, pending.count * 10 + key - '0');
    return true;
}

void KeyInputState::SetPrefix(char prefix) {
    pending.prefix = prefix;
}

PendingKeys KeyInputState::Take() {
    PendingKeys keys = pending;
    pending = {};
    return keys;
}
