package io.local.anibrowser

/**
 * JNI bindings for the prebuilt nodejs-mobile runtime. The native symbols live
 * in libanibrowser.so (extracted from the released APK) and are named
 * Java_io_local_anibrowser_NodeBridge_* — so this class must keep this exact
 * package/name to stay bound.
 */
class NodeBridge {
    companion object {
        init {
            System.loadLibrary("anibrowser")
            System.loadLibrary("node")
        }
    }

    // blocks the calling thread until the node event loop drains
    external fun startNodeWithArguments(arguments: Array<String>, modulesPath: String, redirect: Boolean): Int
    external fun registerNodeDataDirPath(dataDir: String)
}