// JNI shim that boots the vendored nodejs-mobile libnode.so inside the app.
// Original code — no third-party bridge: node->java messaging is unused (the
// port handshake goes through a file), and os.homedir() is pointed at the
// app's private dir by setting $HOME before node::Start (libuv reads $HOME).
#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include <cstdlib>
#include <cstring>
#include "node.h"   // vendored by android/fetch-node.sh

static int pipe_stdout[2], pipe_stderr[2];

static void *pump(void *p) {
  int fd = (int)(intptr_t)p;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(fd == pipe_stdout[0] ? ANDROID_LOG_INFO : ANDROID_LOG_ERROR,
                        "NODEJS", buf);
  }
  return nullptr;
}

static void redirect_stdout_stderr() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  pipe(pipe_stdout);
  dup2(pipe_stdout[1], STDOUT_FILENO);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(pipe_stderr);
  dup2(pipe_stderr[1], STDERR_FILENO);
  pthread_t t1, t2;
  pthread_create(&t1, nullptr, pump, (void *)(intptr_t)pipe_stdout[0]);
  pthread_detach(t1);
  pthread_create(&t2, nullptr, pump, (void *)(intptr_t)pipe_stderr[0]);
  pthread_detach(t2);
}

extern "C"
JNIEXPORT void JNICALL
Java_io_local_anibrowser_NodeBridge_registerNodeDataDirPath(JNIEnv *env, jobject,
                                                            jstring dataDir) {
  const char *d = env->GetStringUTFChars(dataDir, nullptr);
  setenv("HOME", d, 1);        // os.homedir() -> <filesDir>
  setenv("TMPDIR", d, 1);
  env->ReleaseStringUTFChars(dataDir, d);
}

extern "C"
JNIEXPORT jint JNICALL
Java_io_local_anibrowser_NodeBridge_startNodeWithArguments(
    JNIEnv *env, jobject, jobjectArray arguments, jstring modulesPath,
    jboolean redirect) {
  const char *mp = env->GetStringUTFChars(modulesPath, nullptr);
  setenv("NODE_PATH", mp, 1);
  env->ReleaseStringUTFChars(modulesPath, mp);

  jsize n = env->GetArrayLength(arguments);
  // libuv requires argv strings in contiguous memory
  size_t total = 0;
  for (jsize i = 0; i < n; i++) {
    jstring s = (jstring)env->GetObjectArrayElement(arguments, i);
    total += env->GetStringUTFLength(s) + 1;
    env->DeleteLocalRef(s);
  }
  char *buf = (char *)calloc(total + n + 1, 1);
  char *argv[128];
  char *cur = buf;
  for (jsize i = 0; i < n && i < 127; i++) {
    jstring s = (jstring)env->GetObjectArrayElement(arguments, i);
    const char *a = env->GetStringUTFChars(s, nullptr);
    strcpy(cur, a);
    argv[i] = cur;
    cur += strlen(cur) + 1;
    env->ReleaseStringUTFChars(s, a);
    env->DeleteLocalRef(s);
  }

  if (redirect) redirect_stdout_stderr();
  int rc = node::Start(n, argv);   // blocks until the node event loop drains
  free(buf);
  return (jint)rc;
}