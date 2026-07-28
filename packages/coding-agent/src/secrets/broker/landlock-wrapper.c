// landlock-wrapper.c — restrict fs-write to listed dirs, then exec the target.
//
// Usage: landlock-wrapper <writable-dir> [writable-dir ...] -- <command> [args...]
//
// Policy: the ruleset handles WRITE-CLASS actions only (write, truncate,
// make_*, remove_*). Reads and execution stay unrestricted everywhere
// (children need system libs + binaries); writes are allowed ONLY beneath
// the listed dirs. Exits 125 on setup failure so the spawner can tell a
// sandbox-setup error apart from the child's own exit code.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/landlock.h>

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

/* Kernel uapi values (include/uapi/linux/landlock.h). Older glibc headers
 * predate ABI v2, so define anything missing — the values are stable ABI. */
#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_WRITE_FILE
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_FILE
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 4)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_DIR
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 5)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_DIR
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_REG
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SOCK
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_FIFO
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_BLOCK
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SYM
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static const unsigned long long WRITE_CLASS_ACCESS =
    LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE |
    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |
    LANDLOCK_ACCESS_FS_REFER |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR;

static int add_write_dir(int ruleset_fd, const char *path) {
    struct landlock_path_beneath_attr attr;
    memset(&attr, 0, sizeof(attr));
    attr.parent_fd = open(path, O_PATH | O_CLOEXEC);
    if (attr.parent_fd < 0) {
        fprintf(stderr, "landlock-wrapper: open %s: %s\n", path, strerror(errno));
        return -1;
    }
    attr.allowed_access = WRITE_CLASS_ACCESS;
    int rc = syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
    int saved = errno;
    close(attr.parent_fd);
    if (rc < 0) {
        fprintf(stderr, "landlock-wrapper: add_rule %s: %s\n", path, strerror(saved));
    }
    return rc;
}

int main(int argc, char **argv) {
    int sep = -1;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { sep = i; break; }
    }
    if (sep < 0 || sep + 1 >= argc) {
        fprintf(stderr, "usage: landlock-wrapper <writable-dir> [...] -- <command> [args...]\n");
        return 125;
    }

    struct landlock_ruleset_attr ruleset;
    memset(&ruleset, 0, sizeof(ruleset));
    ruleset.handled_access_fs = WRITE_CLASS_ACCESS;
    int ruleset_fd = syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
    if (ruleset_fd < 0) {
        fprintf(stderr, "landlock-wrapper: create_ruleset: %s\n", strerror(errno));
        return 125;
    }
    for (int i = 1; i < sep; i++) {
        if (add_write_dir(ruleset_fd, argv[i]) < 0) return 125;
    }
    /* Landlock restrict_self requires no_new_privs (or CAP_SYS_ADMIN). */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        fprintf(stderr, "landlock-wrapper: no_new_privs: %s\n", strerror(errno));
        return 125;
    }
    if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) {
        fprintf(stderr, "landlock-wrapper: restrict_self: %s\n", strerror(errno));
        return 125;
    }
    close(ruleset_fd);

    execvp(argv[sep + 1], &argv[sep + 1]);
    fprintf(stderr, "landlock-wrapper: exec %s: %s\n", argv[sep + 1], strerror(errno));
    return 125;
}
