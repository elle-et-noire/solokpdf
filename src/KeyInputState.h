/* Copyright 2026 the SolokPDF project authors (see AUTHORS file).
   License: GPLv3 */

struct PendingKeys {
    int count = 0;
    char prefix = 0;
};

struct KeyInputState {
    PendingKeys Get() const;
    bool AddDigit(int key);
    void SetPrefix(char prefix);
    PendingKeys Take();

  private:
    PendingKeys pending;
};
