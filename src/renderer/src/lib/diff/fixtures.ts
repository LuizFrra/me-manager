// Recorded with real `git diff` / `git diff --no-index` output (git 2.x) from throwaway repos.

export const SINGLE_HUNK = `diff --git a/single.txt b/single.txt
index 85c3040..e50310a 100644
--- a/single.txt
+++ b/single.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`

export const MULTI_HUNK = `diff --git a/multi.txt b/multi.txt
index ac9837c..923cd5e 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,6 +1,6 @@
 line 1
 line 2
-line 3
+line three
 line 4
 line 5
 line 6
@@ -24,7 +24,7 @@ line 23
 line 24
 line 25
 line 26
-line 27
+line twenty-seven
 line 28
 line 29
 line 30
`

export const ADDED_FILE = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..39963cd
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand new
+file
`

export const DELETED_FILE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 71f1645..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-to be deleted
-second
`

export const RENAME_ONLY = `diff --git a/old-name.txt b/new-name.txt
similarity index 100%
rename from old-name.txt
rename to new-name.txt
`

export const BINARY = `diff --git a/blob.bin b/blob.bin
index 1506486..8267e3b 100644
Binary files a/blob.bin and b/blob.bin differ
`

export const NO_NEWLINE = `diff --git a/nonl.txt b/nonl.txt
index 20cbb4d..db1dabe 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1 +1 @@
-no newline
\\ No newline at end of file
+no newline, changed
\\ No newline at end of file
`

export const OMITTED_COUNTS = `diff --git a/one.txt b/one.txt
index 5626abf..e438487 100644
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-one
+uno
`

/** A path with a space: git appends a tab to the ---/+++ lines. */
export const SPACE_IN_PATH = `diff --git a/sp ace.txt b/sp ace.txt
index 587be6b..975fbec 100644
--- a/sp ace.txt\t
+++ b/sp ace.txt\t
@@ -1 +1 @@
-x
+y
`

/** Content lines that look like ---/+++ headers. */
export const HEADER_LIKE_CONTENT = `diff --git a/tricky.txt b/tricky.txt
index 5ebcbf5..791b602 100644
--- a/tricky.txt
+++ b/tricky.txt
@@ -1,3 +1,2 @@
--- header-like
-++ plus-like
+++ added-like
 keep
`

/** `git diff --no-index /dev/null <file>`, as used for untracked files. */
export const UNTRACKED_NO_INDEX = `diff --git a/untracked.txt b/untracked.txt
new file mode 100644
index 0000000..d4cfcc2
--- /dev/null
+++ b/untracked.txt
@@ -0,0 +1,2 @@
+untracked
+<script>alert(1)</script>
`

/** Non-ASCII paths are C-quoted by git (core.quotePath). */
export const QUOTED_PATH = `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index 7898192..6178079 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-a
+b
`

export const QUOTED_RENAME = `diff --git "a/caf\\303\\251.txt" "b/na\\303\\257ve.txt"
similarity index 100%
rename from "caf\\303\\251.txt"
rename to "na\\303\\257ve.txt"
`

/** `chmod +x` and nothing else. */
export const MODE_ONLY = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`

/** `chmod +x` with an edit. */
export const MODE_AND_CONTENT = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
index 422c2b7..55dce13
--- a/run.sh
+++ b/run.sh
@@ -1,2 +1,2 @@
 a
-b
+B
`

export const EMPTY_ADDED = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`

export const EMPTY_DELETED = `diff --git a/empty.txt b/empty.txt
deleted file mode 100644
index e69de29..0000000
`

export const BINARY_ADDED = `diff --git a/new.bin b/new.bin
new file mode 100644
index 0000000..bdc955b
Binary files /dev/null and b/new.bin differ
`

export const BINARY_DELETED = `diff --git a/img.png b/img.png
deleted file mode 100644
index f584f40..0000000
Binary files a/img.png and /dev/null differ
`

/** A file replaced by a symlink: git writes the deletion and the addition as two diffs. */
export const FILE_TO_SYMLINK = `diff --git a/link b/link
deleted file mode 100644
index ce01362..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-hello
diff --git a/link b/link
new file mode 120000
index 0000000..33b030c
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+run.sh
\\ No newline at end of file
`

/** A file converted from LF to CRLF line endings: the lines only differ by their carriage return. */
export const LF_TO_CRLF = `diff --git a/crlf.txt b/crlf.txt
index b77b4eb..0aa0f34 100644
--- a/crlf.txt
+++ b/crlf.txt
@@ -1,3 +1,3 @@
 keep\r
-x
-y
+x\r
+y\r
`
