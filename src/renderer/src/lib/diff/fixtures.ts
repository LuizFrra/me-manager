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
