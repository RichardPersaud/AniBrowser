package io.local.anibrowser;

public class NodeBridge {
    static {
        System.loadLibrary("anibrowser");
        System.loadLibrary("node");
    }

    public native Integer startNodeWithArguments(String[] arguments, String modulesPath,
                                                 boolean redirectOutputToLogcat);

    public native void registerNodeDataDirPath(String dataDir);
}