#include <jni.h>
#include <cstring>
#include <cstdlib>
#include <android/log.h>

#include "node.h"

#define TAG "Uplayer/JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// Bridges NodeRunner.startNodeWithArguments(String[]) to nodejs-mobile's
// node::Start(argc, argv). Blocks for the lifetime of the Node process.
extern "C" JNIEXPORT jint JNICALL
Java_com_uplayer_app_NodeRunner_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {

    jsize argc = env->GetArrayLength(arguments);

    // First pass: total length needed for a contiguous argv buffer.
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        total += strlen(c) + 1; // + null terminator
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }

    char *buffer = (char *) calloc(total, sizeof(char));
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    if (buffer == nullptr || argv == nullptr) {
        LOGE("Out of memory building argv");
        free(buffer);
        free(argv);
        return -1;
    }

    char *cursor = buffer;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(cursor, c, len);
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    argv[argc] = nullptr;

    int result = node::Start((int) argc, argv);

    free(buffer);
    free(argv);
    return (jint) result;
}
