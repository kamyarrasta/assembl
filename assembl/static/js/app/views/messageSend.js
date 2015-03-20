'use strict';

define(['backbone', 'backbone.marionette', 'app', 'underscore', 'jquery', 'common/context', 'common/collectionManager', 'utils/permissions', 'objects/messagesInProgress', 'utils/i18n', 'jquery-autosize', 'models/message', 'models/agents', 'bluebird', 'backbone.modal', 'backbone.marionette.modals'],
    function (Backbone, Marionette, Assembl, _, $, Ctx, CollectionManager, Permissions, MessagesInProgress, i18n, autosize, Messages, Agents, Promise) {

        /**
         * @init
         *
         * @param {
         *
         * reply_message_id:  The id of the message model this replies to
         *  (if any)
         *
         * reply_idea:  The idea object this message comments or
         *  replies to (if any)
         *
         * cancel_button_label:  String, the label used for the Cancel button
         *
         * send_button_label:  String, the label used for the Send button
         *
         * allow_setting_subject:  Boolean, if true, the user is allowed to set
         *  his own subject for the message
         *
         * subject_label:  String:  If set, the label of the subject field.
         *
         * default_subject:  String:  If set, the dfault subject if the user
         *  doesn't change it.  Can be used even if allow_setting_subject is
         *  false.  Is the default value sent to the server.
         *
         * mandatory_subject_missing_msg:  String.  If set, the user must
         *  provide a mesasge subject.  If he doesn't, this string is used as
         *  the error message
         *
         * body_help_message:  String:  The text present in the body field to
         *  tell the user what to do.  It is NOT used as a default value sent
         *  to the server, the user must replace it.
         *
         * mandatory_body_missing_msg:  String.  Providing a body is always
         *  mandatory.  Only sets the error displayed to the user if he doesn't
         *  provide a body
         *
         * messageList: MessageListView that we expect to refresh once the
         *  message has been processed
         *
         * send_callback:  Function.  A callback to call once the message has
         *  been accepted by the server, and the mesasgeList has refreshed.
         *
         *  }
         */

        var messageSend = Marionette.ItemView.extend({
            template: '#tmpl-messageSend',
            className: 'messageSend',
            initialize: function (options) {
                //console.log("options given to the constructor of messageSend: ", options);
                this.options = options;
                this.sendInProgress = false;
                this.initialBody = (this.options.body_help_message !== undefined) ?
                    this.options.body_help_message : i18n.gettext('Type your message here...');

                this.messageList = options.messageList;
                this.msg_in_progress_ctx = options.msg_in_progress_ctx
            },

            ui: {
                sendButton: '.messageSend-sendbtn',
                cancelButton: '.messageSend-cancelbtn',
                messageBody: '.messageSend-body',
                messageSubject: '.messageSend-subject',
                topicSubject: '.topic-subject .formfield'
            },

            events: {
                'click @ui.sendButton': 'onSendMessageButtonClick',
                'click @ui.cancelButton': 'onCancelMessageButtonClick',
                'blur @ui.messageBody': 'onBlurMessage',
                'keyup @ui.messageBody': 'onChangeBody'
            },

            serializeData: function () {
                return {
                    i18n: i18n,
                    body_help_message: this.initialBody,
                    allow_setting_subject: this.options.allow_setting_subject || this.options.allow_setting_subject,
                    cancel_button_label: this.options.cancel_button_label ? this.options.cancel_button_label : i18n.gettext('Cancel'),
                    send_button_label: this.options.send_button_label ? this.options.send_button_label : i18n.gettext('Send'),
                    subject_label: this.options.subject_label ? this.options.subject_label : i18n.gettext('Subject:'),
                    canPost: Ctx.getCurrentUser().can(Permissions.ADD_POST),
                    msg_in_progress_body: this.options.msg_in_progress_body,
                    msg_in_progress_title: this.options.msg_in_progress_title,
                    reply_idea: 'reply_idea' in this.options ? this.options.reply_idea : null
                }
            },

            onRender: function () {
                Ctx.removeCurrentlyDisplayedTooltips(this.$el);
                Ctx.initTooltips(this.$el);
            },

            onSendMessageButtonClick: function (ev) {
                var btn = $(ev.currentTarget),
                    that = this,
                    btn_original_text = btn.text(),
                    message_body = this.ui.messageBody.val(),
                    message_subject_field = this.ui.topicSubject,
                    message_subject = message_subject_field.val() || this.options.default_subject,
                    reply_idea_id = null,
                    reply_message_id = null,
                    success_callback = null,
                    chosenTargetIdeaField = this.$el.find('.messageSend-target input:checked');
                console.log("chosenTargetIdea:", chosenTargetIdeaField);
                console.log("chosenTargetIdea val:", chosenTargetIdeaField.val());

                if(this.sendInProgress !== false) {
                  return;
                }
                /*
                if (this.options.reply_idea) {
                    reply_idea_id = this.options.reply_idea.getId();
                }
                */
                if ( chosenTargetIdeaField && chosenTargetIdeaField.val() )
                {
                    reply_idea_id = chosenTargetIdeaField.val();
                }
                if (this.options.reply_message_id) {
                    reply_message_id = this.options.reply_message_id;
                }

                if (!message_subject && (this.options.mandatory_subject_missing_msg || (!reply_idea_id && !reply_message_id))) {
                    if (this.options.mandatory_subject_missing_msg) {
                        alert(this.options.mandatory_subject_missing_msg)
                    } else {
                        alert(i18n.gettext('You need to set a subject before you can send your message...'));
                    }
                    return;
                }
                if (!message_body) {
                    if (this.options.mandatory_body_missing_msg) {
                        alert(this.options.mandatory_body_missing_msg)
                    } else {
                        alert(i18n.gettext('You need to type a message before you can send your message...'));
                    }
                    return;
                }
                this.sendInProgress = true;
                this.savePartialMessage();
                btn.text(i18n.gettext('Sending...'));
                // This is not too good, but it allows the next render to come.
                message_subject_field.value = "";

                var model = new Messages.Model({
                    subject: message_subject,
                    message: message_body,
                    reply_id: reply_message_id,
                    idea_id: reply_idea_id
                });

                model.save(null, {
                    success: function (model, resp) {
                        btn.text(i18n.gettext('Message posted!'));

                        that.ui.messageBody.val('');
                        that.ui.messageSubject.val('');
                        that.sendInProgress = false;
                        /**
                         * Show a popin asking the user to receive notifications if he is posting his first message in the discussion, and does not already receive all default discussion's notifications.
                         * Note: Currently in Assembl we can receive notifications only if we have a "participant" role (which means that here we have a non-null "roles.get('role')"). This role is only given to a user in discussion's parameters, or when the user "subscribes" to the discussion (subscribing gives the "participant" role to the user and also activates discussion's default notifications for the user).
                         * But, we cannot consider that the user does not already receive notifications by checking that he does not have the participant role. Because some discussions can give automatically the add_post permission to all logged in accounts (system.Authenticated role), instead of only those who have the participant role. So these accounts can post messages but are not subscribed to any notification, so we want to show them the first post pop-in.
                         * */
                        //that.roles = new RolesModel.Model();
                        var collectionManager = new CollectionManager();
                        if (Ctx.getDiscussionId() && Ctx.getCurrentUserId()) {
                            Promise.join(collectionManager.getLocalRoleCollectionPromise(),
                                collectionManager.getNotificationsUserCollectionPromise(),
                                collectionManager.getNotificationsDiscussionCollectionPromise(),
                                function (allRole, notificationsUser, notificationsDiscussion) {
                                    //console.log("allRole: ", allRole);
                                    //console.log("notificationsUser: ", notificationsUser);
                                    //console.log("notificationsDiscussion: ", notificationsDiscussion);

                                    var defaultActiveNotificationsDicussion = _.filter(notificationsDiscussion.models, function (m) {
                                        // keep only the list of notifications which become active when a user follows a discussion
                                        return (m.get('creation_origin') === 'DISCUSSION_DEFAULT') && (m.get('status') === 'ACTIVE');
                                    });

                                    var userActiveNotifications = _.filter(notificationsUser.models, function (m) {
                                        return (m.get('status') === 'ACTIVE');
                                    });

                                    //if (allRole.models.length) {
                                    //    that.roles = allRole.models[0];
                                    //}
                                    

                                    var agent = new Agents.Model();
                                    agent.getSingleUser();
                                    agent.fetch({'success': function(agent, response, options) {
                                        //if ((agent.get('post_count') === 0 || agent.get('post_count') < 2) && this.roles.get('role') === null) {
                                        if (
                                            (agent.get('post_count') === 0 || agent.get('post_count') < 2)
                                            && userActiveNotifications.length < defaultActiveNotificationsDicussion.length
                                        ) { // we could make a real diff here but this is enough for now
                                            that.showPopInFirstPost();
                                        }
                                    }});
                                }
                            );
                        }

                        

                        // clear on success... so not lost in case of failure.
                        MessagesInProgress.clearMessage(that.msg_in_progress_ctx);
                        if (that.messageList) {
                            that.listenToOnce(that.messageList, "messageList:render_complete", function () {
                                if (_.isFunction(that.options.send_callback)) {
                                    that.options.send_callback();
                                }
                                var el = that.ui.messageBody;
                                if (el.length > 0)
                                    el[0].text = '';
                                el = that.ui.messageSubject;
                                if (el.length > 0)
                                    el[0].text = '';

                                setTimeout(function () {
                                    //TODO:  This delay will no longer be necessary once backbone sync is done below in sendPostToServer
                                    //console.log("Calling showMessageById for "+data['@id']);
                                    Assembl.vent.trigger('messageList:showMessageById', model.id);

                                }, 1000);
                            });
                        }
                        setTimeout(function () {
                            btn.text(btn_original_text);
                            that.ui.cancelButton.trigger('click');
                        }, 5000);
                    },
                    error: function (model, resp) {
                      that.sendInProgress = false;
                      console.error('ERROR: onSendMessageButtonClick', model, resp);
                    }
                })

            },

            onCancelMessageButtonClick: function () {
                this.clearPartialMessage();
                this.ui.sendButton.addClass("hidden");
                this.ui.cancelButton.addClass("hidden");
            },

            onBlurMessage: function () {
                this.savePartialMessage();
            },

            savePartialMessage: function () {
                var message_body = this.ui.messageBody,
                    message_title = this.ui.messageSubject;
                if (message_body.length > 0 || message_title.length > 0) {
                  MessagesInProgress.saveMessage(this.msg_in_progress_ctx, message_body.val(), message_title.val());
                }
            },

            clearPartialMessage: function () {
                this.ui.messageBody.val('');
                MessagesInProgress.clearMessage(this.msg_in_progress_ctx);
            },

            
            onChangeBody: function () {
                this.ui.messageBody.autosize();

                /**
                 * not necesary anymore 
                 *
                 var message_body = this.ui.messageBody.val();
                if (message_body && message_body.length > 0) {
                    this.ui.sendButton.removeClass("hidden");
                    this.ui.cancelButton.removeClass("hidden");
                }
                else {
                    this.ui.sendButton.addClass("hidden");
                    this.ui.cancelButton.addClass("hidden");
                }*/
            },

            showPopInFirstPost: function () {
                Assembl.vent.trigger('navBar:subscribeOnFirstPost');
            }

        });

        return messageSend;
    });
